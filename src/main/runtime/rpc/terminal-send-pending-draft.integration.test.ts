import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'
import { AGENT_PROMPT_BRACKETED_PASTE_START } from '../../../shared/agent-launch/startup/agent-prompt-injection'
import { AgentPromptPendingInputError } from '../terminal/input/agent-prompt-permission-hold'

const CLAUDE_RULE = '─'.repeat(60)

/** A `terminal.send` RPC request shaped like the CLI's text-plus-Enter agent prompt. */
function cliPrompt(handle: string, text: string): RpcRequest {
  return {
    id: 'request-1',
    authToken: 'test-token',
    method: 'terminal.send',
    params: {
      terminal: handle,
      text,
      enter: true,
      agentPrompt: true,
      client: { id: 'orca-cli', type: 'desktop' }
    }
  }
}

/** A real `OrcaRuntimeService` whose one Claude pane renders `composerRow` as its composer. */
async function makeClaudeRuntime(composerRow: string): Promise<{
  runtime: OrcaRuntimeService
  write: ReturnType<typeof vi.fn>
  handle: string
}> {
  const runtime = new OrcaRuntimeService()
  // Why: echo Claude's working title on Enter so submission verification resolves.
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
  const frame = `✻ Cogitated for 6s\r\n${CLAUDE_RULE}\r\n${composerRow}`
  runtime.onPtyData('pty-1', frame, 1)
  const [terminal] = (await runtime.listTerminals()).terminals
  return { runtime, write, handle: terminal.handle }
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

  it('pastes into an empty composer that shows a dim placeholder', async () => {
    vi.useFakeTimers()
    const { runtime, write, handle } = await makeClaudeRuntime(
      '❯ \x1b[2mTry "refactor <filepath>"\x1b[22m\x1b[3G'
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const send = dispatcher.dispatch(cliPrompt(handle, 'review this change'))
    await vi.waitFor(() => expect(write).toHaveBeenCalled())
    expect(String(write.mock.calls[0]?.[1])).toContain(
      `${AGENT_PROMPT_BRACKETED_PASTE_START}review this change`
    )
    await vi.runAllTimersAsync()
    expect(await send).toMatchObject({
      ok: true,
      result: { send: { accepted: true, bytesWritten: expect.any(Number) } }
    })
    expect(write.mock.calls.some((call) => call[1] === '\r')).toBe(true)
  })

  it('refuses a draft that appears while beforeWrite is pending', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime('❯ ')
    // Why: warm the agent lookup terminal.send does first; these tests call the writer directly.
    await runtime.isTerminalRunningSettledPromptAgent(handle)

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'Status update: the build is green.', {
        inputKind: 'driving',
        beforeWrite: async () => {
          runtime.onPtyData('pty-1', 'Refactor the login page', 2)
          // Why: drain the queued emulator write so the draft is on screen first.
          await runtime.listTerminals()
        }
      })
    ).rejects.toBeInstanceOf(AgentPromptPendingInputError)
    expect(write).not.toHaveBeenCalled()
  })

  // Why: a provider frame can lag the renderer's local echo; the renderer may only add a refusal.
  it('refuses on a renderer draft the provider frame has not caught up to', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime('\u276F ')
    await runtime.isTerminalRunningSettledPromptAgent(handle)
    runtime['providerSnapshotPreferredPtys'].add('pty-1')
    runtime['readRendererVisibleSnapshotLines'] = async () => ({
      lines: [CLAUDE_RULE, '\u276F half-typed by the user'],
      draft: 'half-typed by the user'
    })

    const send = runtime.sendTerminalAgentPrompt(handle, 'Status update: the build is green.', {
      inputKind: 'driving'
    })
    await expect(send).rejects.toBeInstanceOf(AgentPromptPendingInputError)
    await expect(send).rejects.toMatchObject({ pendingInput: 'half-typed by the user' })
    expect(write).not.toHaveBeenCalled()
  })

  // Why: an empty renderer read means "nothing to add", never "there is no draft".
  it('still pastes when the renderer is empty and the screen shows no draft', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime('\u276F ')
    await runtime.isTerminalRunningSettledPromptAgent(handle)
    runtime['providerSnapshotPreferredPtys'].add('pty-1')
    runtime['readRendererVisibleSnapshotLines'] = async () => ({ lines: [] })

    vi.useFakeTimers()
    const send = runtime.sendTerminalAgentPrompt(handle, 'Status update: the build is green.', {
      inputKind: 'driving'
    })
    await vi.waitFor(() => expect(write).toHaveBeenCalled())
    expect(String(write.mock.calls[0]?.[1])).toContain(
      `${AGENT_PROMPT_BRACKETED_PASTE_START}Status update: the build is green.`
    )
    await vi.runAllTimersAsync()
    expect(await send).toMatchObject({ accepted: true })
    expect(write.mock.calls.some((call) => call[1] === '\r')).toBe(true)
  })

  // Why: the re-read awaits and a pane can stop meanwhile, so assertWritable must run after it.
  it('refuses when the pty stops while the composer re-read is in flight', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime('\u276F ')
    await runtime.isTerminalRunningSettledPromptAgent(handle)

    const readVisibleTerminalState = runtime['readVisibleTerminalState'].bind(runtime)
    // Armed inside beforeWrite so only the SECOND read — the one this guard owns — trips it.
    let armed = false
    runtime['readVisibleTerminalState'] = async (ptyId: string) => {
      const state = await readVisibleTerminalState(ptyId)
      if (armed) {
        runtime.markPtyStopRequested(ptyId)
      }
      return state
    }

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'Status update: the build is green.', {
        inputKind: 'driving',
        beforeWrite: async () => {
          armed = true
        }
      })
    ).rejects.toThrow('terminal_not_writable')
    expect(write).not.toHaveBeenCalled()
  })
})
