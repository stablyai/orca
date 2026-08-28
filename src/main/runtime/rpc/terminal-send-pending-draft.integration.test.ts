import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'
import { AGENT_PROMPT_BRACKETED_PASTE_START } from '../../../shared/agent-prompt-injection'

const CLAUDE_RULE = '─'.repeat(60)

function cliPrompt(handle: string, text: string, extra: Record<string, unknown> = {}): RpcRequest {
  return {
    id: 'request-1',
    authToken: 'test-token',
    method: 'terminal.send',
    params: {
      terminal: handle,
      text,
      enter: true,
      agentPrompt: true,
      client: { id: 'orca-cli', type: 'desktop' },
      ...extra
    }
  }
}

async function makeClaudeRuntime(composerRow: string): Promise<{
  runtime: OrcaRuntimeService
  write: ReturnType<typeof vi.fn>
  handle: string
}> {
  const runtime = new OrcaRuntimeService()
  // Why: submission is verified by the agent starting a turn, which a live Claude reports
  // through its title; the mock echoes that once Enter arrives so accepted sends resolve.
  const write = vi.fn((ptyId: string, data: string) => {
    if (data === '\r') {
      runtime.onPtyData(ptyId, '\x1b]0;✻ Claude working\x07', Date.now())
    }
    return true
  })
  runtime.setPtyController({
    write,
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: 'repo-1::/tmp/worktree',
        title: 'Claude',
        activeLeafId: 'pane-1',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: 'repo-1::/tmp/worktree',
        leafId: 'pane-1',
        paneRuntimeId: 1,
        ptyId: 'pty-1',
        paneTitle: 'Claude'
      }
    ]
  })
  // Why: the composer draft only exists as rendered output — the user's keystrokes
  // never pass through the runtime, so the screen is the sole evidence of a draft.
  const frame = `✻ Cogitated for 6s\r\n${CLAUDE_RULE}\r\n${composerRow}`
  runtime.onPtyData('pty-1', frame, 1)
  const [terminal] = (await runtime.listTerminals()).terminals
  return { runtime, write, handle: terminal.handle }
}

async function expectPasted(
  send: Promise<unknown>,
  write: ReturnType<typeof vi.fn>,
  text: string
): Promise<void> {
  await vi.waitFor(() => expect(write).toHaveBeenCalled())
  expect(String(write.mock.calls[0]?.[1])).toContain(`${AGENT_PROMPT_BRACKETED_PASTE_START}${text}`)
  await vi.runAllTimersAsync()
  expect(await send).toMatchObject({
    ok: true,
    result: { send: { accepted: true, bytesWritten: expect.any(Number) } }
  })
  expect(write.mock.calls.some((call) => call[1] === '\r')).toBe(true)
}

describe('terminal.send into a composer with unsent input', () => {
  afterEach(() => vi.useRealTimers())

  it('refuses to submit a CLI prompt on top of the user draft and reports it', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime(
      '❯ Refactor the login page so that it'
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      cliPrompt(handle, 'Status update from the other terminal: the build is green.')
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        send: {
          handle,
          accepted: false,
          bytesWritten: 0,
          refusedReason: 'pending-input',
          pendingInput: 'Refactor the login page so that it'
        }
      }
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('still refuses when the caret was moved to the start of the draft', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime(
      '❯ Refactor the login page so that it\x1b[3G'
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      cliPrompt(handle, 'Status update from the other terminal: the build is green.')
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        send: {
          accepted: false,
          refusedReason: 'pending-input',
          pendingInput: 'Refactor the login page so that it'
        }
      }
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('pastes into an empty composer that shows a dim placeholder', async () => {
    vi.useFakeTimers()
    const { runtime, write, handle } = await makeClaudeRuntime(
      '❯ \x1b[2mTry "refactor <filepath>"\x1b[22m\x1b[3G'
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await expectPasted(
      dispatcher.dispatch(cliPrompt(handle, 'review this change')),
      write,
      'review this change'
    )
  })

  it('does not read a permission dialog option list as a draft', async () => {
    vi.useFakeTimers()
    // Why: as Claude Code 2.1.246 draws it — glyph indented one column, cursor hidden.
    const { runtime, write, handle } = await makeClaudeRuntime(
      ' Do you want to create hello.txt?\r\n ❯ 1. Yes\r\n   2. No\x1b[A\x1b[2G\x1b[?25l'
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await expectPasted(
      dispatcher.dispatch(cliPrompt(handle, 'review this change')),
      write,
      'review this change'
    )
  })

  it('pastes into an empty composer', async () => {
    vi.useFakeTimers()
    const { runtime, write, handle } = await makeClaudeRuntime('❯ ')
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await expectPasted(
      dispatcher.dispatch(cliPrompt(handle, 'review this change')),
      write,
      'review this change'
    )
  })

  it('appends to the draft when the caller opts in with allowPendingInput', async () => {
    vi.useFakeTimers()
    const { runtime, write, handle } = await makeClaudeRuntime('❯ keep this draft')
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await expectPasted(
      dispatcher.dispatch(cliPrompt(handle, ' and this', { allowPendingInput: true })),
      write,
      ' and this'
    )
  })
})
