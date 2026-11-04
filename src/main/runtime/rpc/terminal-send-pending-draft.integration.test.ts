import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'
import { AGENT_PROMPT_BRACKETED_PASTE_START } from '../../../shared/agent-launch/startup/agent-prompt-injection'
import { AgentPromptPendingInputError } from '../terminal/input/agent-prompt-permission-hold'

const CLAUDE_RULE = '─'.repeat(60)

/** A `terminal.send` RPC request shaped like the CLI's text-plus-Enter agent prompt. */
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

/**
 * A real `OrcaRuntimeService` with one pane whose rendered screen is a Claude composer.
 *
 * The frame is fed through `onPtyData`, so the guard reads it the same way it reads a live
 * pane. `composerRow` is the composer's prompt row: `'\u276F '` for an empty composer, or the
 * glyph plus text for one already holding a draft.
 *
 * @returns The runtime, the pty write spy that proves whether bytes were sent, and the handle.
 */
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

/** Assert a send was accepted and actually wrote `text` followed by its own Enter. */
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

  // Why: the write path re-validates request activity, generation, permission and PTY admission
  // across `beforeWrite`; composer state is an invariant of the same standing, so a draft the
  // user starts during that hook must refuse rather than be pasted onto. Regression for #16290.
  it('refuses a draft that appears while beforeWrite is pending', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime('❯ ')
    // Why: terminal.send resolves the pane's agent before writing. This test drives the write
    // path directly so it can supply beforeWrite, so it warms that same lookup first.
    await runtime.isTerminalRunningSettledPromptAgent(handle)

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'Status update: the build is green.', {
        inputKind: 'driving',
        beforeWrite: async () => {
          runtime.onPtyData('pty-1', 'Refactor the login page', 2)
          // Why: onPtyData queues the emulator write; drain it the way the fixture does, so
          // the draft is on screen before the write path continues.
          await runtime.listTerminals()
        }
      })
    ).rejects.toBeInstanceOf(AgentPromptPendingInputError)
    expect(write).not.toHaveBeenCalled()
  })

  // Why: the composer re-read awaits the emulator, and a pane can stop mid-await. The
  // writability assert therefore has to run AFTER that read — checking before it leaves the
  // initial PTY write reachable on a pane that is already going away.
  // Why: a provider-preferred pty's evidence is a frame serialized by its provider, which can
  // be current in the output sequence yet still lag the renderer's own screen — a keystroke
  // echoed locally is visible before it round-trips. The renderer may only ADD a refusal.
  it('refuses on a renderer draft the provider frame has not caught up to', async () => {
    const { runtime, write, handle } = await makeClaudeRuntime('\u276F ')
    await runtime.isTerminalRunningSettledPromptAgent(handle)
    const ptyId = 'pty-1'

    runtime['providerSnapshotPreferredPtys'].add(ptyId)
    runtime['readRendererVisibleSnapshotLines'] = async () => ({
      lines: [CLAUDE_RULE, '\u276F half-typed by the user'],
      draft: 'half-typed by the user'
    })

    const result = await runtime
      .sendTerminalAgentPrompt(handle, 'Status update: the build is green.', {
        inputKind: 'driving'
      })
      .then(
        () => null,
        (error: unknown) => error
      )
    if (!(result instanceof AgentPromptPendingInputError)) {
      throw new Error(`expected a pending-input refusal, got ${String(result)}`)
    }
    expect(result.pendingInput).toBe('half-typed by the user')
    expect(write).not.toHaveBeenCalled()
  })

  // Why: `null` from the renderer means "nothing to add", never "there is no draft" — an empty
  // or unmounted renderer must leave the provider/headless verdict exactly as it was.
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
