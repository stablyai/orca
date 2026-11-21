import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import {
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS
} from '../../../provider-process/provider-process-supervisor'
import { spawnCodexAppServerProcess } from '../../app-server/codex-app-server-process-tree-kill'
import type { CodexStateDbBackfillStatus } from './codex-state-db'
import { runCodexStateDbBackfillRecovery } from './codex-state-db-backfill-recovery'
import {
  alive,
  createSupervisedProbeRig,
  waitFor
} from '../../structured/session-lifecycle/supervised-probe-owner.test-fixture'

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
