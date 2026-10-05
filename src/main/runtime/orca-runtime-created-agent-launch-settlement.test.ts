import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { settledPtyLaunchAgent } from './runtime-terminal-state-records'
import type { RuntimeStore } from './runtime-store-contract'

describe('a runtime-created agent terminal', () => {
  it('is settled together with its agent, never as "no agent" first', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
    const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
    const leafId = '33333333-3333-4333-8333-333333333333'
    let seenDuringSpawn: unknown = 'not-called'
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        // What the runtime spawn commit registers for an agent spawn: no fresh-spawn settlement.
        runtime.registerPty('pty-new', TEST_WORKTREE_ID, null, {
          tabId: 'agent-tab',
          leafId,
          incarnationId: 'inc-new'
        })
        const pty = runtime['ptysById'].get('pty-new')
        seenDuringSpawn = pty ? settledPtyLaunchAgent(pty) : 'missing'
        return { id: 'pty-new', incarnationId: 'inc-new' }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'agent-tab',
      leafId,
      launchAgent: 'claude'
    })

    expect(seenDuringSpawn).toBeUndefined()
    const pty = runtime['ptysById'].get('pty-new')
    expect(pty ? settledPtyLaunchAgent(pty) : 'missing').toBe('claude')
  })
})
