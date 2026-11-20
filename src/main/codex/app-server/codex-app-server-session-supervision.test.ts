import { existsSync, readFileSync } from 'node:fs'

import { describe, it } from 'vitest'
import { CodexAppServerTimeoutError, runCodexAppServerSession } from './codex-app-server-session'

import {
  alive,
  createSupervisedProbeRig
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
})
