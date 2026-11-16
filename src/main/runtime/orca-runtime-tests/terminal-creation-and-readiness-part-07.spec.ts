import { describe, expect, it, vi } from 'vitest'
import '../../../shared/agent-launch/startup/agent-prompt-injection'
import '../../../shared/orchestration/workers/orca-dispatch-status-prompt'
import { OrcaRuntimeService } from '../orca-runtime'
import './runtime-test-module-registration.spec'
import '../orca-runtime-test-mocks/setup.spec'
import { TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('blocks tui-idle when a newer prompt follows a stale prompt and ready header', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Update available! 0.131.0 -> 0.132.0\n',
        'Press enter to continue\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n',
        'Hooks need review\n',
        'Press enter to confirm\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'agent-hooks-review-prompt'
    })
  })
})
