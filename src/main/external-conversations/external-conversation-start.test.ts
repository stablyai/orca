import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationLauncher } from './external-conversation-start'

it('starts the requested connector agent in a background terminal even with chat enabled', async () => {
  const createTerminal = vi.fn(
    async (_workspace: string, options: { onStartupPromptCarry?: (carried: boolean) => void }) => {
      options.onStartupPromptCarry?.(true)
      return { handle: 'connector-terminal' }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real launcher reaches only these runtime I/O boundaries; no agent process is started.
  const runtime = {
    showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'workspace-1',
      path: '/repo/task',
      connectionId: null
    })),
    requireStore: () => ({ getSettings: () => ({ experimentalNativeChat: true }) }),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    createTerminal
  } as unknown as OrcaRuntimeService
  const published = vi.fn()

  const result = await runtimeConversationLauncher(runtime).launch(
    {
      agent: 'codex',
      target: { kind: 'existing', worktree: 'id:workspace-1' },
      prompt: 'fix the test'
    },
    published,
    new AbortController().signal
  )

  expect(createTerminal).toHaveBeenCalledExactlyOnceWith(
    'id:workspace-1',
    expect.objectContaining({
      startupAgent: 'codex',
      startupPrompt: 'fix the test',
      presentation: 'background'
    })
  )
  expect(result).toMatchObject({
    worktreeId: 'workspace-1',
    outcome: { kind: 'terminal', handle: 'connector-terminal' },
    receipt: { mode: 'terminal', preferred: 'terminal' },
    prompt: { outcome: 'handed-to-terminal' }
  })
  expect(published).toHaveBeenCalledExactlyOnceWith(result)
})
