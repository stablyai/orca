import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const PICKER =
  'Select model for Codex\r\n  gpt-6-astra\r\nPress enter to confirm or esc to go back\r\n'
const COMPOSER =
  '\x1b[2J\x1b[HModel changed to gpt-6-astra medium\r\n\r\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\r\n\r\n  gpt-6-astra · medium\x1b[3;3H\x1b[?25h'
const APPROVAL = '\x1b[2J\x1b[HCodex permission required\r\nAllow once\r\nReject\r\n'

async function pane(
  onPaste?: (
    runtime: Awaited<ReturnType<typeof createAgentPromptSubmissionRuntime>>['runtime']
  ) => void
) {
  return createAgentPromptSubmissionRuntime((runtime, data) => {
    if (data === '\r') {
      runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    } else {
      onPaste?.(runtime)
    }
  }, 'codex')
}

describe('Codex model picker observation lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('retires erased picker history and admits a prompt in the same pane', async () => {
    const { runtime, handle, writes } = await pane()
    try {
      runtime.onPtyData('pty-prompt', PICKER, Date.now())
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        status: 'permission'
      })
      runtime.onPtyData('pty-prompt', COMPOSER, Date.now())
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.not.toMatchObject({
        status: 'permission'
      })
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1000 })
      ).resolves.toMatchObject({ satisfied: true })
      await expect(
        runtime.sendTerminalAgentPrompt(handle, 'continue the task')
      ).resolves.toMatchObject({ accepted: true })
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      runtime.onPtyExit('pty-prompt', 0)
    }
  })

  it('reconciles direct submission without a prior status read', async () => {
    const { runtime, handle } = await pane()
    try {
      runtime.onPtyData('pty-prompt', PICKER, Date.now())
      runtime.onPtyData('pty-prompt', COMPOSER, Date.now())
      await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).resolves.toMatchObject({
        accepted: true
      })
    } finally {
      runtime.onPtyExit('pty-prompt', 0)
    }
  })

  it.each([
    ['open picker', PICKER],
    ['actual approval', APPROVAL],
    [
      'quoted composer',
      '\r\nModel changed to gpt-6-astra medium\r\n› Ask Codex to do anything\r\n gpt-6-astra · medium\r\n'
    ],
    ['trust prompt', '\x1b[2J\x1b[HDo you trust this workspace?\r\nPress enter to confirm\r\n'],
    ['hook review', '\x1b[2J\x1b[HCodex hooks need review\r\nPress enter to confirm\r\n']
  ])('keeps %s blocked', async (_name, next) => {
    const { runtime, handle, writes } = await pane()
    try {
      runtime.onPtyData('pty-prompt', PICKER, Date.now())
      runtime.onPtyData('pty-prompt', next, Date.now())
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        status: 'permission'
      })
      await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).rejects.toThrow(
        'agent_prompt_blocked'
      )
      expect(writes).toHaveLength(0)
    } finally {
      runtime.onPtyExit('pty-prompt', 0)
    }
  })

  it('keeps the retired modal closed while the new prompt redraws in the composer', async () => {
    const { runtime, handle } = await pane((runtime) => {
      runtime.onPtyData(
        'pty-prompt',
        COMPOSER.replace('Ask Codex to do anything', 'continue'),
        Date.now()
      )
    })
    try {
      runtime.onPtyData('pty-prompt', PICKER, Date.now())
      runtime.onPtyData('pty-prompt', COMPOSER, Date.now())
      await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).resolves.toMatchObject({
        accepted: true
      })
    } finally {
      runtime.onPtyExit('pty-prompt', 0)
    }
  })

  it.each(['Codex permission required', 'Codex waiting'])(
    'preserves live permission title %s after close',
    async (title) => {
      const { runtime, handle, writes } = await pane()
      try {
        runtime.onPtyData('pty-prompt', PICKER, Date.now())
        runtime.onPtyData('pty-prompt', COMPOSER, Date.now())
        runtime.onPtyData('pty-prompt', `\x1b]0;${title}\x07`, Date.now())
        await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).rejects.toThrow(
          'agent_prompt_blocked'
        )
        expect(writes).toHaveLength(0)
      } finally {
        runtime.onPtyExit('pty-prompt', 0)
      }
    }
  )

  it('refuses submission when the screen cannot be read', async () => {
    const { runtime, handle, writes } = await pane()
    const reader = runtime as unknown as {
      readVisibleTerminalState(ptyId: string): Promise<RuntimeVisibleTerminalState | null>
    }
    vi.spyOn(reader, 'readVisibleTerminalState').mockResolvedValue(null)
    try {
      runtime.onPtyData('pty-prompt', PICKER, Date.now())
      runtime.onPtyData('pty-prompt', COMPOSER, Date.now())
      await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).rejects.toThrow(
        'agent_prompt_blocked'
      )
      expect(writes).toHaveLength(0)
    } finally {
      runtime.onPtyExit('pty-prompt', 0)
    }
  })

  it('fences a permission cycle occurring during the foreground screen read', async () => {
    const { runtime, handle, writes } = await pane()
    const reader = runtime as unknown as {
      readVisibleTerminalState(ptyId: string): Promise<RuntimeVisibleTerminalState | null>
    }
    const read = reader.readVisibleTerminalState.bind(reader)
    vi.spyOn(reader, 'readVisibleTerminalState').mockImplementationOnce(async (ptyId) => {
      const result = await read(ptyId)
      runtime.onPtyData(ptyId, '\x1b]0;Codex permission required\x07', Date.now())
      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', Date.now())
      return result
    })
    try {
      runtime.onPtyData('pty-prompt', PICKER, Date.now())
      runtime.onPtyData('pty-prompt', COMPOSER, Date.now())
      await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).rejects.toThrow(
        'agent_prompt_blocked'
      )
      expect(writes).toHaveLength(0)
    } finally {
      runtime.onPtyExit('pty-prompt', 0)
    }
  })

  it('preserves a newer permission during paste even after the modal was retired', async () => {
    const { runtime, handle, writes } = await pane((runtime) => {
      runtime.onPtyData('pty-prompt', APPROVAL, Date.now())
      runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    })
    try {
      runtime.onPtyData('pty-prompt', PICKER, Date.now())
      runtime.onPtyData('pty-prompt', COMPOSER, Date.now())
      await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).rejects.toThrow(
        'agent_prompt_blocked'
      )
      expect(writes).toHaveLength(1)
      expect(writes).not.toContain('\r')
    } finally {
      runtime.onPtyExit('pty-prompt', 0)
    }
  })
})
