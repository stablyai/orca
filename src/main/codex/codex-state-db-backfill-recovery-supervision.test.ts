import { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import {
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS
} from '../provider-process/provider-process-supervisor'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import type { CodexStateDbBackfillStatus } from './codex-state-db'
import { runCodexStateDbBackfillRecovery } from './codex-state-db-backfill-recovery'
import {
  alive,
  createSupervisedProbeRig,
  waitFor,
  type SupervisedProbeRig
} from './supervised-probe-owner.test-fixture'

const INCOMPLETE: CodexStateDbBackfillStatus = {
  kind: 'incomplete',
  stateDbPath: '/state.sqlite',
  status: 'running'
}

const OWNER = String.raw`
import { runCodexStateDbBackfillRecovery } from './codex-state-db-backfill-recovery'
void runCodexStateDbBackfillRecovery(process.env.ORCA_TEST_CODEX_HOME!, new AbortController().signal, {
  resolveCommand: () => process.env.ORCA_TEST_STAND_IN!,
  readStatus: () => ({ kind: 'incomplete', stateDbPath: '/state.sqlite', status: 'running' })
}).catch(() => {})
setInterval(() => {}, 60_000)
`

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
let rig: SupervisedProbeRig | null = null

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.unstubAllEnvs()
  rig?.cleanup()
  rig = null
})

function decodedSupervisorSpec(env: unknown): unknown {
  const encoded =
    typeof env === 'object' && env !== null && 'ORCA_PROVIDER_SUPERVISOR_SPEC' in env
      ? String(env.ORCA_PROVIDER_SUPERVISOR_SPEC)
      : ''
  return JSON.parse(Buffer.from(encoded, 'base64').toString() || 'null')
}

describe('Codex backfill recovery app-server supervision', () => {
  it('runs the POSIX recovery app-server under a session-lifetime supervisor', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    // Never signalled: terminate is a stub here, and a handle-less ChildProcess must not be killed.
    const child = new ChildProcess()
    const calls: { program: string; args: string[]; options: Record<string, unknown> }[] = []
    const spawnProcess: CodexAppServerSpawn = (program, args, options) => {
      calls.push({ program, args, options })
      return child
    }
    const terminate = vi.fn(async () => {})
    const readStatus = vi
      .fn()
      .mockReturnValueOnce(INCOMPLETE)
      .mockReturnValue({ kind: 'complete', stateDbPath: '/state.sqlite' })

    await expect(
      runCodexStateDbBackfillRecovery('/managed-home', new AbortController().signal, {
        spawnProcess,
        resolveCommand: () => '/bin/codex',
        readStatus,
        terminate,
        sleep: vi.fn(async () => {}),
        now: vi.fn(() => 1_000)
      })
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 1 })

    const [{ program, args, options }] = calls
    expect(program).toBe(process.execPath)
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      '/bin/codex',
      ...CODEX_READ_ONLY_APP_SERVER_ARGS
    ])
    expect(options).toMatchObject({ cwd: '/managed-home', detached: true })
    expect(options.env).toMatchObject({ CODEX_HOME: '/managed-home' })
    expect(decodedSupervisorSpec(options.env)).toMatchObject({
      lifetime: 'session',
      cwd: '/managed-home'
    })
    expect(terminate).toHaveBeenCalledWith(child, true)
  })
})

describe.runIf(process.platform !== 'win32')('supervised Codex backfill recovery processes', () => {
  it('stops the whole recovery group when the recovery is aborted', async () => {
    rig = createSupervisedProbeRig()
    for (const [key, value] of Object.entries(rig.env)) {
      vi.stubEnv(key, value)
    }
    const standIn = rig.writeStandIn('codex')
    const controller = new AbortController()

    const recovery = runCodexStateDbBackfillRecovery(rig.dir, controller.signal, {
      resolveCommand: () => standIn,
      readStatus: () => INCOMPLETE
    })
    const pids = await rig.readPids()
    controller.abort()

    await expect(recovery).resolves.toEqual({ outcome: 'stopped', spawnCount: 1 })
    // Its stdin end comes first; the supervisor then SIGTERMs, and SIGKILLs the group after.
    expect(existsSync(rig.signalFile) && readFileSync(rig.signalFile, 'utf8')).toBe('SIGTERM')
    expect(alive(pids.provider)).toBe(false)
    // A SIGTERM to the root alone left this descendant running for good.
    expect(alive(pids.grandchild)).toBe(false)
  })

  it('drains, then stops the recovery group, when its owner is SIGKILLed', async () => {
    rig = createSupervisedProbeRig()
    const standIn = rig.writeStandIn('codex')
    const bundle = await rig.bundleOwner(OWNER, __dirname)
    const owner = rig.launchOwner(bundle, {
      ORCA_TEST_STAND_IN: standIn,
      ORCA_TEST_CODEX_HOME: rig.dir
    })
    const pids = await rig.readPids()

    owner.kill('SIGKILL')

    expect(
      await waitFor(
        () => !alive(pids.provider) && !alive(pids.grandchild),
        PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000
      )
    ).toBe(true)
    // A gone owner gets the close its owner makes: the stdin end, its grace, and only then SIGTERM.
    const events = rig.readEvents()
    expect(events['stdin-end']).toBeDefined()
    expect((events.SIGTERM ?? 0) - (events['stdin-end'] ?? 0)).toBeGreaterThanOrEqual(
      PROVIDER_STDIN_END_GRACE_MS - 50
    )
  })
})
