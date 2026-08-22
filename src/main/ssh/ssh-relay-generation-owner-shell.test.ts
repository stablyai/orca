// Runs the generated owner/identity/cleanup scripts through a real POSIX shell against real files
// and a real process. String assertions cannot catch a shell syntax error or a `stat`/`ps` flag the
// host rejects; this can. On Linux it exercises the /proc branch, on macOS the `ps` branch.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serializeRelayOwnerManifest } from '../../shared/relay-owner-manifest'
import { wrapRemoteCommandForPosixShell } from './ssh-connection-utils'
import {
  createRelayGenerationToken,
  parseRelayRelaunchReadinessOutput,
  parseRelayGenerationIdentityOutput,
  parseRelayGenerationTerminateOutput,
  parseRelayOwnerProbeOutput,
  relayRelaunchReadinessCommand,
  relayGenerationIdentityCommand,
  relayGenerationTerminateCommand,
  relayOwnerProbeCommand,
  type RelayGenerationIdentity
} from './ssh-relay-generation-owner-commands'

const run = promisify(execFile)
const describePosix = process.platform === 'win32' ? describe.skip : describe
// Why: root bypasses DAC permission bits, so a 0000 directory is still searchable there and the
// unreadable-parent case cannot be produced.
const unprivilegedPosixIt = it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)
// Why: these drive several /bin/sh + ps round trips plus real signal delivery. On a loaded machine
// that outruns vitest's 30s default and surfaces as an opaque harness timeout rather than a result.
const PROCESS_TEST_TIMEOUT_MS = 120_000

async function sh(script: string): Promise<string> {
  const { stdout } = await run('/bin/sh', ['-c', script], { maxBuffer: 1024 * 1024 })
  return stdout
}

/** Runs through the same printf-octal wrapper `execCommand` applies to every remote POSIX command. */
async function shWrapped(script: string): Promise<string> {
  const wrapped = wrapRemoteCommandForPosixShell(script)
  const { stdout } = await run('/bin/sh', ['-c', wrapped], { maxBuffer: 1024 * 1024 })
  return stdout
}

let dir: string
let sockPath: string
let manifestPath: string
let server: Server | null = null
const children: ChildProcess[] = []

function socketIdentity(path = sockPath): string {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs / 1_000_000_000n}`
}

function writeManifest(overrides?: {
  generation?: string
  pid?: number
  ino?: number
  ctime?: number
}): string {
  const generation = overrides?.generation ?? createRelayGenerationToken()
  const stat = statSync(sockPath, { bigint: true })
  writeFileSync(
    manifestPath,
    serializeRelayOwnerManifest({
      generation,
      pid: overrides?.pid ?? process.pid,
      socketPath: sockPath,
      socketDev: Number(stat.dev),
      socketIno: overrides?.ino ?? Number(stat.ino),
      socketCtimeSeconds: overrides?.ctime ?? Number(stat.ctimeNs / 1_000_000_000n)
    }),
    { mode: 0o600 }
  )
  chmodSync(manifestPath, 0o600)
  return generation
}

/** A live process whose argv carries `relay.js` and the generation token, like a detached relay. */
async function spawnFakeRelay(generation: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(function(){},60000)', 'relay.js', '--owner-token', generation],
    { stdio: 'ignore' }
  )
  children.push(child)
  // Why: `spawn` resolves a pid at fork, before exec has replaced argv. Probing straight away can
  // observe the pre-exec command line on a loaded machine, so wait until the host can see the real
  // argv before any test asserts on identity.
  await waitForIdentity(child.pid as number, generation, 'match')
  return child
}

async function waitForIdentity(
  pid: number,
  generation: string,
  kind: RelayGenerationIdentity['kind'],
  timeoutMs = 15_000
): Promise<RelayGenerationIdentity> {
  const command = relayGenerationIdentityCommand(pid, generation)
  const deadline = Date.now() + timeoutMs
  let last: RelayGenerationIdentity = { kind: 'indeterminate' }
  while (Date.now() < deadline) {
    last = parseRelayGenerationIdentityOutput(await sh(command))
    if (last.kind === kind) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for pid ${pid} identity ${kind}; last was ${last.kind}`)
}

function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    // Why: the remote script SIGTERMs the child, so its exit is often already in flight — or done —
    // by the time this registers. Without the guard the listener never fires.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for pid ${child.pid} to exit`)),
      timeoutMs
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-owner-shell-'))
  sockPath = join(dir, 'relay-abc.sock')
  manifestPath = `${sockPath}.owner`
  server = createServer()
  await new Promise<void>((resolve) => (server as Server).listen(sockPath, resolve))
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
  if (server) {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()))
    server = null
  }
  rmSync(dir, { recursive: true, force: true })
})

describePosix('relayOwnerProbeCommand against a real shell', () => {
  it('accepts a real socket and a real 0600 manifest', async () => {
    const generation = writeManifest()
    const probe = parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    expect(probe).toMatchObject({ kind: 'owned' })
    expect(probe.kind === 'owned' && probe.manifest.generation).toBe(generation)
    expect(probe.kind === 'owned' && probe.socketIdentity).toBe(socketIdentity())
  })

  it('survives the printf-octal remote command wrapper unchanged', async () => {
    writeManifest()
    const direct = parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    const wrapped = parseRelayOwnerProbeOutput(
      await shWrapped(relayOwnerProbeCommand(sockPath)),
      sockPath
    )
    expect(wrapped).toEqual(direct)
  })

  it('reports a legacy relay with no manifest', async () => {
    expect(
      parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    ).toMatchObject({ kind: 'no-manifest' })
  })

  it('reports a group-readable manifest as rejected', async () => {
    writeManifest()
    chmodSync(manifestPath, 0o644)
    expect(
      parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    ).toEqual({ kind: 'manifest-rejected' })
  })

  it('reports a symlinked manifest as rejected without following it', async () => {
    const decoy = join(dir, 'decoy')
    writeFileSync(decoy, 'orca-relay-owner-1\n', { mode: 0o600 })
    symlinkSync(decoy, manifestPath)
    expect(
      parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    ).toEqual({ kind: 'manifest-rejected' })
  })

  it('reports a manifest whose inode no longer matches the live socket as superseded', async () => {
    writeManifest({ ino: 1 })
    expect(
      parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    ).toMatchObject({ kind: 'manifest-superseded' })
  })

  it('reports a manifest whose change time no longer matches the live socket as superseded', async () => {
    writeManifest({ ctime: 1 })
    expect(
      parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    ).toMatchObject({ kind: 'manifest-superseded' })
  })

  it('refuses a manifest that forges a second sentinel block', async () => {
    const generation = writeManifest()
    appendFileSync(
      manifestPath,
      `__ORCA_RELAY_OWNER_END__\n__ORCA_RELAY_OWNER__\nsockid=${socketIdentity()}\nmanifest=missing\n`
    )
    chmodSync(manifestPath, 0o600)
    const probe = parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    expect(probe).toEqual({ kind: 'manifest-malformed' })
    expect(generation).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a symlink standing in for the socket rather than reporting it absent', async () => {
    const decoyDir = mkdtempSync(join(tmpdir(), 'relay-owner-decoy-'))
    const decoy = createServer()
    const decoySock = join(decoyDir, 'live.sock')
    await new Promise<void>((resolve) => decoy.listen(decoySock, resolve))
    const linked = join(dir, 'linked.sock')
    symlinkSync(decoySock, linked)
    try {
      expect(parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(linked)), linked)).toEqual({
        kind: 'socket-unusable'
      })
    } finally {
      await new Promise<void>((resolve) => decoy.close(() => resolve()))
      rmSync(decoyDir, { recursive: true, force: true })
    }
  })

  it('survives a manifest whose final line has no trailing newline', async () => {
    const generation = writeManifest()
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/\n$/, ''), {
      mode: 0o600
    })
    chmodSync(manifestPath, 0o600)
    const probe = parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(sockPath)), sockPath)
    expect(probe).toMatchObject({ kind: 'owned' })
    expect(probe.kind === 'owned' && probe.manifest.generation).toBe(generation)
  })

  it('reports an absent socket', async () => {
    const missing = join(dir, 'gone.sock')
    expect(parseRelayOwnerProbeOutput(await sh(relayOwnerProbeCommand(missing)), missing)).toEqual({
      kind: 'socket-absent'
    })
  })
})

describePosix(
  'relayGenerationIdentityCommand against a real process',
  { timeout: PROCESS_TEST_TIMEOUT_MS },
  () => {
    it(
      'matches a live process carrying the generation token in argv',
      async () => {
        const generation = createRelayGenerationToken()
        const child = await spawnFakeRelay(generation)
        const identity = parseRelayGenerationIdentityOutput(
          await sh(relayGenerationIdentityCommand(child.pid as number, generation))
        )
        expect(identity.kind).toBe('match')
        expect(identity.kind === 'match' && identity.startToken.length).toBeGreaterThan(4)
      },
      PROCESS_TEST_TIMEOUT_MS
    )

    it(
      'reports the same start token across repeated reads of one process',
      async () => {
        const generation = createRelayGenerationToken()
        const child = await spawnFakeRelay(generation)
        const command = relayGenerationIdentityCommand(child.pid as number, generation)
        const first = parseRelayGenerationIdentityOutput(await sh(command))
        const second = parseRelayGenerationIdentityOutput(await sh(command))
        expect(second).toEqual(first)
      },
      PROCESS_TEST_TIMEOUT_MS
    )

    it(
      'reports a mismatch for a live process carrying a different token',
      async () => {
        const child = await spawnFakeRelay(createRelayGenerationToken())
        expect(
          parseRelayGenerationIdentityOutput(
            await sh(
              relayGenerationIdentityCommand(child.pid as number, createRelayGenerationToken())
            )
          )
        ).toEqual({ kind: 'mismatch' })
      },
      PROCESS_TEST_TIMEOUT_MS
    )

    it(
      'reports a mismatch for a live process that is not a relay',
      async () => {
        const generation = createRelayGenerationToken()
        const child = spawn(
          process.execPath,
          ['-e', `setInterval(function(){},60000)`, generation],
          {
            stdio: 'ignore'
          }
        )
        children.push(child)
        expect(
          parseRelayGenerationIdentityOutput(
            await sh(relayGenerationIdentityCommand(child.pid as number, generation))
          )
        ).toEqual({ kind: 'mismatch' })
      },
      PROCESS_TEST_TIMEOUT_MS
    )

    it(
      'reports gone for an exited process',
      async () => {
        const generation = createRelayGenerationToken()
        const child = await spawnFakeRelay(generation)
        const pid = child.pid as number
        child.kill('SIGKILL')
        await waitForExit(child)
        await expect(waitForIdentity(pid, generation, 'gone')).resolves.toEqual({ kind: 'gone' })
      },
      PROCESS_TEST_TIMEOUT_MS
    )
  }
)

describePosix(
  'relayGenerationTerminateCommand against a real process',
  { timeout: PROCESS_TEST_TIMEOUT_MS },
  () => {
    it(
      'sends SIGTERM only when the token and start token both still match',
      async () => {
        const generation = createRelayGenerationToken()
        const child = await spawnFakeRelay(generation)
        const pid = child.pid as number
        const identity = parseRelayGenerationIdentityOutput(
          await sh(relayGenerationIdentityCommand(pid, generation))
        )
        expect(identity.kind).toBe('match')
        const startToken = identity.kind === 'match' ? identity.startToken : ''

        const result = parseRelayGenerationTerminateOutput(
          await sh(relayGenerationTerminateCommand(pid, generation, startToken))
        )

        expect(result).toBe('signalled')
        await waitForExit(child)
        await expect(waitForIdentity(pid, generation, 'gone')).resolves.toEqual({ kind: 'gone' })
      },
      PROCESS_TEST_TIMEOUT_MS
    )

    it(
      'refuses to signal when the start token no longer matches',
      async () => {
        const generation = createRelayGenerationToken()
        const child = await spawnFakeRelay(generation)
        const pid = child.pid as number

        const result = parseRelayGenerationTerminateOutput(
          await sh(relayGenerationTerminateCommand(pid, generation, 'linux:not-the-start-token'))
        )

        expect(result).toBe('mismatch')
        expect(
          parseRelayGenerationIdentityOutput(
            await sh(relayGenerationIdentityCommand(pid, generation))
          ).kind
        ).toBe('match')
      },
      PROCESS_TEST_TIMEOUT_MS
    )

    it(
      'refuses to signal a recycled pid whose argv lost the token',
      async () => {
        const generation = createRelayGenerationToken()
        const child = await spawnFakeRelay(createRelayGenerationToken())
        const result = parseRelayGenerationTerminateOutput(
          await sh(relayGenerationTerminateCommand(child.pid as number, generation, 'linux:1'))
        )
        expect(result).toBe('mismatch')
        expect(child.killed).toBe(false)
      },
      PROCESS_TEST_TIMEOUT_MS
    )
  }
)

describePosix('relayRelaunchReadinessCommand against real artifacts', () => {
  it('refuses a LIVE successor socket even when handed that socket own identity', async () => {
    // Why: this is the whole point of the non-mutating design. The old cleanup command would take
    // this exact input — a matching dev:ino:ctime — and unlink a listening socket. Same-second inode
    // reuse produces precisely this state on ext4, so it is forged here rather than raced for.
    const generation = writeManifest()
    const identityBefore = socketIdentity()
    const inodeBefore = statSync(sockPath).ino

    const readiness = parseRelayRelaunchReadinessOutput(
      await sh(relayRelaunchReadinessCommand(sockPath))
    )

    expect(readiness).toBe('present')
    expect(statSync(sockPath).isSocket()).toBe(true)
    expect(statSync(sockPath).ino).toBe(inodeBefore)
    expect(socketIdentity()).toBe(identityBefore)
    // The socket is still live and connectable.
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection({ path: sockPath })
      probe.once('connect', () => {
        probe.destroy()
        resolve()
      })
      probe.once('error', reject)
    })
    expect(generation).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cannot delete a successor manifest because it never names one', async () => {
    const generation = writeManifest({ generation: 'c'.repeat(64) })
    const before = readFileSync(manifestPath, 'utf8')

    await sh(relayRelaunchReadinessCommand(sockPath))

    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    expect(relayRelaunchReadinessCommand(sockPath)).not.toContain('.owner')
    expect(generation).toBe('c'.repeat(64))
  })

  it('reports absent for an empty pathname and creates nothing', async () => {
    const missing = join(dir, 'gone.sock')
    const before = readdirSync(dir).sort()

    expect(
      parseRelayRelaunchReadinessOutput(await sh(relayRelaunchReadinessCommand(missing)))
    ).toBe('absent')
    expect(readdirSync(dir).sort()).toEqual(before)
  })

  it('reports present for a stale socket node left by a crashed relay', async () => {
    const orphanDir = mkdtempSync(join(tmpdir(), 'relay-owner-orphan-'))
    const staged = join(orphanDir, 'staged.sock')
    const orphan = createServer()
    await new Promise<void>((resolve) => orphan.listen(staged, resolve))
    const stale = join(dir, 'stale.sock')
    renameSync(staged, stale)
    // close() now unlinks the name it bound, which no longer exists — the node at `stale` survives.
    await new Promise<void>((resolve) => orphan.close(() => resolve()))

    expect(parseRelayRelaunchReadinessOutput(await sh(relayRelaunchReadinessCommand(stale)))).toBe(
      'present'
    )
    expect(lstatSync(stale).isSocket()).toBe(true)
    rmSync(orphanDir, { recursive: true, force: true })
  })

  it.each([
    ['a plain file', (p: string) => writeFileSync(p, 'x')],
    ['a directory', (p: string) => mkdirSync(p)],
    ['a dangling symlink', (p: string) => symlinkSync(join(dir, 'nowhere'), p)]
  ])('reports present for %s at the socket path', async (_label, create) => {
    const occupied = join(dir, 'occupied.sock')
    create(occupied)

    expect(
      parseRelayRelaunchReadinessOutput(await sh(relayRelaunchReadinessCommand(occupied)))
    ).toBe('present')
    expect(lstatSync(occupied)).toBeDefined()
  })

  it('survives the printf-octal remote command wrapper unchanged', async () => {
    const direct = parseRelayRelaunchReadinessOutput(
      await sh(relayRelaunchReadinessCommand(sockPath))
    )
    const wrapped = parseRelayRelaunchReadinessOutput(
      await shWrapped(relayRelaunchReadinessCommand(sockPath))
    )
    expect(wrapped).toBe(direct)
  })

  unprivilegedPosixIt('reports unknown when the parent directory cannot be searched', async () => {
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    const hidden = join(locked, 'relay.sock')
    chmodSync(locked, 0o000)
    try {
      expect(
        parseRelayRelaunchReadinessOutput(await sh(relayRelaunchReadinessCommand(hidden)))
      ).toBe('unknown')
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})
