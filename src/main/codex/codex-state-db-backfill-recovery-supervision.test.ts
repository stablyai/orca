import { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import {
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS
} from '../provider-process/provider-process-supervisor'
import {
  spawnCodexAppServerProcess,
  type CodexAppServerSpawn
} from './codex-app-server-process-tree-kill'
import type { CodexStateDbBackfillStatus } from './codex-state-db'
import { runCodexStateDbBackfillRecovery } from './codex-state-db-backfill-recovery'
import { alive, createSupervisedProbeRig, waitFor } from './supervised-probe-owner.test-fixture'

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
function decodedSupervisorSpec(env: unknown): unknown {
  const encoded =
    typeof env === 'object' && env !== null && 'ORCA_PROVIDER_SUPERVISOR_SPEC' in env
      ? String(env.ORCA_PROVIDER_SUPERVISOR_SPEC)
      : ''
  return JSON.parse(Buffer.from(encoded, 'base64').toString() || 'null')
}

describe('Codex backfill recovery app-server supervision', () => {
  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('runs the POSIX recovery app-server under a session-lifetime supervisor', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    // Stub termination: this handle-less child must never be signalled.
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
  it.concurrent('stops the whole recovery group when the recovery is aborted', async ({
    expect,
    onTestFinished
  }) => {
    const rig = createSupervisedProbeRig()
    onTestFinished(() => rig.cleanup())
    const standIn = rig.writeStandIn('codex')
    const controller = new AbortController()

    const recovery = runCodexStateDbBackfillRecovery(rig.dir, controller.signal, {
      resolveCommand: () => standIn,
      readStatus: () => INCOMPLETE,
      spawnProcess: (program, args, options) => {
        if (typeof options.env !== 'object' || options.env === null) {
          throw new Error('Recovery spawn requires a resolved environment')
        }
        return spawnCodexAppServerProcess(program, args, {
          ...options,
          env: { ...options.env, ...rig.env }
        })
      }
    })
    const pids = await rig.readPids()
    controller.abort()

    await expect(recovery).resolves.toEqual({ outcome: 'stopped', spawnCount: 1 })
    expect(existsSync(rig.signalFile) && readFileSync(rig.signalFile, 'utf8')).toBe('SIGTERM')
    expect(alive(pids.provider)).toBe(false)
    expect(alive(pids.grandchild)).toBe(false)
  })

  it.concurrent('drains, then stops the recovery group, when its owner is SIGKILLed', async ({
    expect,
    onTestFinished
  }) => {
    const rig = createSupervisedProbeRig()
    onTestFinished(() => rig.cleanup())
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
    const events = rig.readEvents()
    expect(events['stdin-end']).toBeDefined()
    expect((events.SIGTERM ?? 0) - (events['stdin-end'] ?? 0)).toBeGreaterThanOrEqual(
      PROVIDER_STDIN_END_GRACE_MS - 50
    )
  })
})
