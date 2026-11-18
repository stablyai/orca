import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

describe('a new agent tab whose launch the shell wrapper runs', () => {
  let harness: DaemonAdapterHarness | undefined
  afterEach(async () => {
    harness?.adapter.dispose()
    await harness?.server.shutdown()
    if (harness) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
    harness = undefined
  })

  it('reports it through the daemon reply, so keys typed before connect can go to the agent', async () => {
    harness = await startDaemonAdapterHarness(() =>
      Object.assign(createMockSubprocess(), {
        shellWrapperStartup: {
          staging: { command: 'claude', delivery: 'typed' as const },
          claimPath: '/nonexistent/orca-launch-claim.sh'
        }
      })
    )
    const spawned = await harness.adapter.spawn({ cols: 80, rows: 24, command: 'claude' })
    expect(spawned).toMatchObject({ shellWrapperLaunch: true })
  })
})
