// In-memory Vercel Sandbox with the behaviours the bake-off measured: stop = reboot from an automatic
// snapshot, resume keeps the name and route, and delete leaves automatic snapshots behind.
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { GRANT_COMMAND } from '../src/grants'
import { REVOKE_COMMAND } from '../src/grant-revokes'
import type { NetworkPolicy } from '../src/network-policy'
import {
  ProviderError,
  type CreateSandboxParams,
  type ProviderSandboxState,
  type ProviderSnapshot,
  type RunCommandParams,
  type SandboxProviderApi
} from '../src/sandbox-provider'
import { DESKTOP_COMMAND, DRAIN_COMMAND, ENV_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import type { GoldenImageProviderApi } from '../src/golden-image-provider'

type FakeBox = {
  params: CreateSandboxParams
  status: 'running' | 'stopped'
  sessionId: string
  startedAt: number
  timeoutMs: number
  route: string
  /** Extra exposed ports beyond orcad's (updatePorts / create params). */
  ports: number[]
  policy: NetworkPolicy
  /** orcad's recipe line for the current boot, once the start command ran. */
  orcadReady?: string
  /** Files in the VM, as the files API would read them. */
  files: Map<string, string>
  /** orcad's device registry on the sandbox disk (survives stop/resume). */
  devices: string[]
}

export type FakeBuildCommand = { sessionId: string; env: Record<string, string>; args: string[]; exitCode: number | null; logs: string }

export const READY_PATH = '/home/vercel-sandbox/.orca-sandbox/ready.json'

/** Same sealing as image/vm/orca-sandbox-grant (node:crypto here; the opener under test is portable). */
export function sealLikeVm(recipientB64: string, grantId: string, plaintext: string) {
  const recipient = Buffer.from(recipientB64, 'base64')
  const recipientKey = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: recipient.toString('base64url') }, format: 'jwk' })
  const eph = generateKeyPairSync('x25519')
  const ephRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephRaw, recipient]), 'orca-cloud-grant-v1', 32))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`orca-cloud-grant-v1:${grantId}`))
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()])
  return { v: 1, ephemeralPublicKeyB64: ephRaw.toString('base64'), nonceB64: nonce.toString('base64'), ciphertextB64: ct.toString('base64') }
}

const b64url = (text: string) => Buffer.from(text).toString('base64url')

export type FakeVercel = SandboxProviderApi & GoldenImageProviderApi & {
  /** Environment build commands (startCommand), settable by tests. */
  buildCommands: Map<string, FakeBuildCommand>
  /** What `cat result.json` prints in a build VM. */
  buildResult: string
  /** finalize's runtime check fails (install script removed orcad). */
  runtimeMissing: boolean
  boxes: Map<string, FakeBox>
  snapshots: Map<string, ProviderSnapshot & { sandboxName: string; creationMethod: string; createdAt: number }>
  commands: { sessionId: string; command: string; args?: string[]; env: Record<string, string> }[]
  /** Answers commands the fake does not know (in-VM orca CLI, routine runners); undefined falls through. */
  commandHandler?: (params: RunCommandParams, sessionId: string) => { exitCode: number; stdout: string; stderr: string } | undefined
  failStart: boolean
  failEnvRefresh: boolean
  /** Exit code orca-ssh-keys answers with (0 = success; 3 = image without sshd). */
  sshKeysExit: number
  /** authorized_keys per sandbox name, as orca-ssh-keys maintains it. */
  authorizedKeys: Map<string, string[]>
  /** What orca-desktop-start answers; exitCode 127 = the image has no such command. */
  desktop: { exitCode: number; stdout: string }
  failCreate: boolean
  /** Answers `bash -c <script>` probes (metrics, archive capture); undefined falls through to 127. */
  onScript?: (script: string, sessionId: string) => { exitCode: number; stdout: string; stderr: string } | undefined
  /** Provider snapshot expiry per sandbox name, as last set by create or update. */
  snapshotExpirations: Map<string, number>
  /** Simulates the provider ending a session at its timeout. */
  expire(name: string): void
}

export function createFakeVercel(now: () => number): FakeVercel {
  const boxes = new Map<string, FakeBox>()
  const snapshots: FakeVercel['snapshots'] = new Map()
  const commands: FakeVercel['commands'] = []
  let counter = 0
  const next = (prefix: string) => `${prefix}_${++counter}`
  const state = (box: FakeBox): ProviderSandboxState => ({
    sandbox: {
      name: box.params.name,
      status: box.status,
      currentSessionId: box.sessionId,
      currentSnapshotId: null,
      tags: box.params.tags
    },
    session: { id: box.sessionId, status: box.status, startedAt: box.startedAt, timeoutMs: box.timeoutMs },
    routes: [6768, ...box.ports.filter((port) => port !== 6768)].map((port) => ({
      port,
      url: port === 6768 ? box.route : `${box.route.replace('.vercel.run', '')}-${port}.vercel.run`
    }))
  })
  const bySession = (sessionId: string): FakeBox => {
    const box = [...boxes.values()].find((candidate) => candidate.sessionId === sessionId)
    if (!box) {
      throw new ProviderError(404, 'not_found')
    }
    return box
  }
  const stop = (box: FakeBox): string => {
    box.status = 'stopped'
    box.orcadReady = undefined
    const id = next('snap')
    snapshots.set(id, { id, status: 'created', sourceSessionId: box.sessionId, sandboxName: box.params.name, creationMethod: 'automatic', createdAt: now() })
    return id
  }

  const buildCommands = new Map<string, FakeBuildCommand>()
  const fake: FakeVercel = {
    boxes,
    snapshots,
    commands,
    buildCommands,
    buildResult: '{"repos":[]}',
    runtimeMissing: false,
    async createBuildSandbox(params) {
      return fake.createSandbox({ ...params, snapshotId: `image:${params.image}`, ports: [], networkPolicy: { allow: {} }, snapshotExpirationMs: 0 })
    },
    async createSnapshot(sessionId) {
      const box = bySession(sessionId)
      box.status = 'stopped'
      const id = next('snap_env')
      snapshots.set(id, { id, status: 'created', sourceSessionId: sessionId, sandboxName: box.params.name, creationMethod: 'manual', createdAt: now() })
      return id
    },
    async deleteBuildSandbox(name) {
      boxes.delete(name)
    },
    async startCommand(sessionId, params) {
      bySession(sessionId)
      const id = next('cmd')
      buildCommands.set(id, { sessionId, env: params.env ?? {}, args: params.args ?? [], exitCode: null, logs: '' })
      return id
    },
    async getCommand(_sessionId, commandId) {
      const command = buildCommands.get(commandId)
      if (!command) {
        throw new ProviderError(404, 'not_found')
      }
      return { exitCode: command.exitCode }
    },
    async streamCommandLogs(_sessionId, commandId) {
      const command = buildCommands.get(commandId)
      if (!command) {
        throw new ProviderError(404, 'not_found')
      }
      return new Response(command.logs).body!
    },
    async getSnapshot(snapshotId) {
      const snapshot = snapshots.get(snapshotId)
      return snapshot ? { id: snapshot.id, status: snapshot.status, expiresAt: null } : null
    },
    failStart: false,
    failEnvRefresh: false,
    sshKeysExit: 0,
    authorizedKeys: new Map(),
    desktop: { exitCode: 0, stdout: '{"schemaVersion":1,"port":6080,"display":":1","path":"vnc.html","password":"Ab3dE6gH"}\n' },
    failCreate: false,
    snapshotExpirations: new Map(),
    expire(name) {
      const box = boxes.get(name)
      if (box?.status === 'running') {
        stop(box)
      }
    },
    async createSandbox(params) {
      if (fake.failCreate) {
        throw new ProviderError(500, 'internal_error')
      }
      if (boxes.has(params.name)) {
        throw new ProviderError(409, 'conflict')
      }
      const box: FakeBox = {
        params,
        status: 'running',
        sessionId: next('sess'),
        startedAt: now(),
        timeoutMs: params.timeoutMs,
        route: `https://sb-${counter}.vercel.run`,
        ports: params.ports,
        policy: params.networkPolicy,
        files: new Map(),
        devices: []
      }
      boxes.set(params.name, box)
      return state(box)
    },
    async getSandbox(name, options) {
      const box = boxes.get(name)
      if (!box) {
        return null
      }
      if (box.status === 'stopped' && options.resume) {
        Object.assign(box, {
          status: 'running',
          sessionId: next('sess'),
          startedAt: now(),
          timeoutMs: box.params.timeoutMs
        })
      }
      return state(box)
    },
    async stopSession(sessionId) {
      const box = bySession(sessionId)
      return { snapshotId: box.status === 'running' ? stop(box) : null }
    },
    async extendTimeout(sessionId, durationMs) {
      const box = bySession(sessionId)
      box.timeoutMs += durationMs
      return state(box).session
    },
    async updateNetworkPolicy(sessionId, policy) {
      bySession(sessionId).policy = policy
    },
    async updatePorts(name, ports) {
      const box = boxes.get(name)
      if (!box) {
        throw new ProviderError(404, 'not_found')
      }
      box.ports = [...ports]
      return state(box).routes
    },
    async runCommand(sessionId, params: RunCommandParams) {
      const box = bySession(sessionId)
      if (box.status !== 'running') {
        throw new ProviderError(410, 'sandbox_stopped')
      }
      // A first boot wraps the start script in `bash -c '<prelude>; exec <start>'`: same command to us.
      const command =
        params.command === 'bash' && params.args?.[1]?.endsWith(`exec ${START_COMMAND}`) ? START_COMMAND : params.command
      commands.push({ sessionId, command, args: params.args, env: params.env ?? {} })
      const handled = fake.commandHandler?.(params, sessionId)
      if (handled) {
        return handled
      }
      if (params.command === '/opt/orca/bin/orca-ssh-keys') {
        if (fake.sshKeysExit !== 0) {
          return { exitCode: fake.sshKeysExit, stdout: '', stderr: 'ssh-keys failed' }
        }
        const key = params.env?.ORCA_SSH_PUBLIC_KEY ?? ''
        const blob = key.split(' ')[1]
        const keys = (fake.authorizedKeys.get(box.params.name) ?? []).filter((k) => k.split(' ')[1] !== blob)
        fake.authorizedKeys.set(box.params.name, params.args?.[0] === 'add' ? [...keys, key] : keys)
        const hostKey = `ssh-ed25519 ${'H'.repeat(68)}`
        return { exitCode: 0, stdout: `${JSON.stringify({ port: 2222, user: 'vercel-sandbox', hostKey })}\n`, stderr: '' }
      }
      if (command === START_COMMAND) {
        if (fake.failStart) {
          return { exitCode: 1, stdout: '', stderr: 'orcad crashed' }
        }
        const ownerDevice = `dev-owner-${box.params.name}`
        if (!box.devices.includes(ownerDevice)) {
          box.devices.push(ownerDevice)
        }
        const code = b64url(JSON.stringify({ v: 2, endpoint: box.route, deviceToken: 'fake', publicKeyB64: 'fake', pairedDeviceId: ownerDevice }))
        const ready = { schemaVersion: 1, pairingCode: `orca://pair?code=${code}`, projectRoot: '/vercel/sandbox/project' }
        box.orcadReady = JSON.stringify(ready)
        if (params.env?.ORCA_READY_VIA === 'file') {
          // Like the image: the offer stays in the VM, stdout only says where.
          box.files.set(READY_PATH, `booting\n${box.orcadReady}\n`)
          return { exitCode: 0, stdout: `booting\n${JSON.stringify({ schemaVersion: 1, readyFile: READY_PATH })}\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: `booting\n${box.orcadReady}\n`, stderr: '' }
      }
      if (params.command === 'bash' && params.args?.join(' ').includes('ready.json')) {
        if (!box.orcadReady) {
          return { exitCode: 3, stdout: '', stderr: '' }
        }
        // Like the image: the offer stays in the VM, stdout only says where.
        box.files.set(READY_PATH, `${box.orcadReady}\n`)
        return { exitCode: 0, stdout: `${JSON.stringify({ schemaVersion: 1, readyFile: READY_PATH })}\n`, stderr: '' }
      }
      if (params.command === 'bash' && params.args?.[1]?.includes('result.json')) {
        return fake.runtimeMissing ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: `${fake.buildResult}\n`, stderr: '' }
      }
      if (params.command === '/opt/orca/bin/orca-image-wipe') {
        return { exitCode: 0, stdout: '{"wiped":true}\n', stderr: '' }
      }
      if (params.command === DESKTOP_COMMAND) {
        if (fake.desktop.exitCode === 127) {
          // Real Vercel behaviour for a missing executable.
          throw new ProviderError(400, 'command_failed')
        }
        return { ...fake.desktop, stderr: '' }
      }
      if (params.command === GRANT_COMMAND) {
        const env = params.env ?? {}
        const deviceId = next('dev-grant')
        box.devices.push(deviceId)
        const pairingUrl = `orca://pair?code=${b64url(JSON.stringify({ v: 2, endpoint: env.ORCA_PUBLIC_WSS, deviceToken: `tok-${deviceId}`, publicKeyB64: 'fake', pairedDeviceId: deviceId }))}`
        const scope = env.ORCA_GRANT_KIND === 'mobile' ? 'mobile' : 'runtime'
        const sealed = sealLikeVm(env.ORCA_GRANT_RECIPIENT_KEY!, env.ORCA_GRANT_ID!, JSON.stringify({ pairingUrl, deviceId, scope }))
        return { exitCode: 0, stdout: `${JSON.stringify({ deviceId, sealed })}\n`, stderr: '' }
      }
      if (params.command === REVOKE_COMMAND) {
        const ids = (params.env?.ORCA_REVOKE_DEVICE_IDS ?? '').split(',')
        const before = box.devices.length
        box.devices = box.devices.filter((d) => !ids.includes(d))
        return { exitCode: 0, stdout: `{"revoked":${before - box.devices.length}}\n`, stderr: '' }
      }
      if (params.command === 'bash' && params.args?.join(' ').includes('echo synced')) {
        return { exitCode: 0, stdout: 'synced\n', stderr: '' }
      }
      if (params.command === DRAIN_COMMAND) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (params.command === ENV_COMMAND) {
        return { exitCode: fake.failEnvRefresh ? 3 : 0, stdout: '{"names":0}\n', stderr: '' }
      }
      if (params.command === '/bin/sh' && params.args?.[1]?.includes('credentials.json')) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (params.command === 'bash' && params.args?.[0] === '-c' && fake.onScript) {
        const answered = fake.onScript(params.args[1] ?? '', sessionId)
        if (answered) {
          return answered
        }
      }
      return { exitCode: 127, stdout: '', stderr: 'not found' }
    },
    async updateSnapshotExpiration(name, expirationMs) {
      if (!boxes.has(name)) {
        throw new ProviderError(404, 'not_found')
      }
      fake.snapshotExpirations.set(name, expirationMs)
    },
    async readFile(sessionId, path) {
      return bySession(sessionId).files.get(path) ?? null
    },
    async deleteSandbox(name) {
      const box = boxes.get(name)
      if (box?.status === 'running') {
        stop(box)
      }
      boxes.delete(name)
    },
    async listSnapshots(name) {
      return [...snapshots.values()]
        .filter((snapshot) => snapshot.sandboxName === name)
        .map(({ id, status, sourceSessionId }) => ({ id, status, sourceSessionId }))
    },
    async listSandboxes() {
      return {
        complete: true,
        sandboxes: [...boxes.values()].map((box) => ({
          name: box.params.name,
          status: box.status,
          currentSessionId: box.sessionId,
          tags: box.params.tags
        }))
      }
    },
    async listProjectSnapshots() {
      return {
        complete: true,
        snapshots: [...snapshots.values()].map(({ id, status, creationMethod, createdAt }) => ({ id, status, creationMethod, createdAt }))
      }
    },
    async deleteSnapshot(snapshotId) {
      const snapshot = snapshots.get(snapshotId)
      if (snapshot) {
        snapshot.status = 'deleted'
      }
    }
  }
  return fake
}
