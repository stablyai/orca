// In-memory Vercel Sandbox with the behaviours the bake-off measured: stop = reboot from an automatic
// snapshot, resume keeps the name and route, and delete leaves automatic snapshots behind.
import type { NetworkPolicy } from '../src/network-policy'
import {
  ProviderError,
  type CreateSandboxParams,
  type ProviderSandboxState,
  type ProviderSnapshot,
  type RunCommandParams,
  type SandboxProviderApi
} from '../src/sandbox-provider'
import { DRAIN_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'

type FakeBox = {
  params: CreateSandboxParams
  status: 'running' | 'stopped'
  sessionId: string
  startedAt: number
  timeoutMs: number
  route: string
  policy: NetworkPolicy
}

export type FakeVercel = SandboxProviderApi & {
  boxes: Map<string, FakeBox>
  snapshots: Map<string, ProviderSnapshot & { sandboxName: string; creationMethod: string; createdAt: number }>
  commands: { sessionId: string; command: string; env: Record<string, string> }[]
  failStart: boolean
  failCreate: boolean
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
    routes: [{ port: 6768, url: box.route }]
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
    const id = next('snap')
    snapshots.set(id, { id, status: 'created', sourceSessionId: box.sessionId, sandboxName: box.params.name, creationMethod: 'automatic', createdAt: now() })
    return id
  }

  const fake: FakeVercel = {
    boxes,
    snapshots,
    commands,
    failStart: false,
    failCreate: false,
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
        policy: params.networkPolicy
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
    async runCommand(sessionId, params: RunCommandParams) {
      const box = bySession(sessionId)
      if (box.status !== 'running') {
        throw new ProviderError(410, 'sandbox_stopped')
      }
      commands.push({ sessionId, command: params.command, env: params.env ?? {} })
      if (params.command === START_COMMAND) {
        if (fake.failStart) {
          return { exitCode: 1, stdout: '', stderr: 'orcad crashed' }
        }
        const ready = { schemaVersion: 1, pairingCode: `orca://pair?code=${box.params.name}`, projectRoot: '/vercel/sandbox/project' }
        return { exitCode: 0, stdout: `booting\n${JSON.stringify(ready)}\n`, stderr: '' }
      }
      if (params.command === '/opt/orca/bin/orca-image-wipe') {
        return { exitCode: 0, stdout: '{"wiped":true}\n', stderr: '' }
      }
      if (params.command === DRAIN_COMMAND) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 127, stdout: '', stderr: 'not found' }
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
