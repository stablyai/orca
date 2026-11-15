import { existsSync, readFileSync } from 'node:fs'

import { describe, it } from 'vitest'
import {
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS
} from '../../provider-process/provider-process-supervisor'
import { CodexAppServerTimeoutError, runCodexAppServerSession } from './codex-app-server-session'

import {
  alive,
  createSupervisedProbeRig,
  waitFor
} from '../structured/session-lifecycle/supervised-probe-owner.test-fixture'

// Answers initialize, then nothing; it ignores its stdin end, as a wedged Codex can.
const WEDGED_APP_SERVER = String.raw`
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n')
  }
})
`

const OWNER = String.raw`
import { runCodexAppServerSession } from './codex-app-server-session'
void runCodexAppServerSession(
  { command: process.env.ORCA_TEST_STAND_IN!, cliPath: null, args: ['app-server'], timeoutMs: 120_000 },
  () => new Promise<never>(() => {})
).catch(() => {})
setInterval(() => {}, 60_000)
`

describe.runIf(process.platform !== 'win32')('supervised Codex app-server sessions', () => {
  it.concurrent('stops a wedged session at its deadline with SIGTERM to its whole group', async ({
    expect,
    onTestFinished
  }) => {
    const rig = createSupervisedProbeRig()
    onTestFinished(() => rig.cleanup())
    const standIn = rig.writeStandIn('codex', WEDGED_APP_SERVER)

    const readPids = rig.readPids
    const reported: { pids?: { provider: number; grandchild: number } } = {}
    // Let PID discovery fail before the session deadline if a slow host never arms the stand-in.
    const startBudgetMs = 5_000
    const session = runCodexAppServerSession(
      {
        command: standIn,
        cliPath: null,
        args: ['app-server'],
        env: rig.env,
        timeoutMs: startBudgetMs + 1_000
      },
      async () => {
        reported.pids = await readPids(startBudgetMs)
        return new Promise<never>(() => {})
      }
    )

    await expect(session).rejects.toBeInstanceOf(CodexAppServerTimeoutError)
    const { pids } = reported
    expect(pids).toBeDefined()
    if (!pids) {
      return
    }
    // Graceful shutdown protects Codex mid-write.
    expect(existsSync(rig.signalFile) && readFileSync(rig.signalFile, 'utf8')).toBe('SIGTERM')
    expect(alive(pids.provider)).toBe(false)
    // The group ladder reaches a descendant that ignores SIGTERM; a root-only kill misses it.
    expect(alive(pids.grandchild)).toBe(false)
  })

  it.concurrent('drains, then stops the session group, when its owner is SIGKILLed mid-session', async ({
    expect,
    onTestFinished
  }) => {
    const rig = createSupervisedProbeRig()
    onTestFinished(() => rig.cleanup())
    const standIn = rig.writeStandIn('codex', WEDGED_APP_SERVER)
    const bundle = await rig.bundleOwner(OWNER, __dirname)
    const owner = rig.launchOwner(bundle, { ORCA_TEST_STAND_IN: standIn })
    const pids = await rig.readPids()

    owner.kill('SIGKILL')

    expect(
      await waitFor(
        () => !alive(pids.provider) && !alive(pids.grandchild),
        PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000
      )
    ).toBe(true)
    // Owner death still allows stdin EOF grace before SIGTERM.
    const events = rig.readEvents()
    expect(events['stdin-end']).toBeDefined()
    expect((events.SIGTERM ?? 0) - (events['stdin-end'] ?? 0)).toBeGreaterThanOrEqual(
      PROVIDER_STDIN_END_GRACE_MS - 50
    )
  })
})
