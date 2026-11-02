import { PLUGIN_HOOK_SPECS } from '../../../../shared/plugins/events/plugin-hook-payloads'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { pluginHookWanted, runPluginHook } from '../../../plugins/hooks/plugin-hook-dispatch'
import type { TerminalInputSource } from '../../terminal-input-admission'

type TerminalSendAction = { text?: string; enter?: boolean; interrupt?: boolean }

/**
 * Whether `terminal.send` runs for this write: only text Orca, the CLI or a plugin sends. A person's
 * typing (desktop, mobile, or an old client that does not say) is never delayed or rewritten.
 */
export function terminalSendHookApplies(
  action: TerminalSendAction,
  options: { inputKind: TerminalInputKind; inputSource?: TerminalInputSource }
): boolean {
  return (
    options.inputKind !== 'query-reply' &&
    (options.inputSource === undefined || options.inputSource === 'programmatic') &&
    typeof action.text === 'string' &&
    action.text.length > 0 &&
    pluginHookWanted('terminal.send')
  )
}

/**
 * Runs `terminal.send` on the host handling the send, before the bytes go to the PTY, so SSH and
 * WSL terminals are decided here too. Throws PluginHookDeniedError on a deny. Agent prompts take
 * `agent.prompt.before` instead.
 */
export async function runTerminalSendPluginHook(
  handle: string,
  action: TerminalSendAction,
  inputKind: Exclude<TerminalInputKind, 'query-reply'>,
  /** The checks the caller ran on the original text, run again on what a plugin wrote. */
  assertRewrittenAllowed: (text: string) => Promise<void>
): Promise<TerminalSendAction> {
  const { text, enter } = await runPluginHook(
    'terminal.send',
    PLUGIN_HOOK_SPECS['terminal.send'].payload,
    { terminalId: handle, text: action.text ?? '', enter: action.enter === true, inputKind }
  )
  if (text !== action.text) {
    await assertRewrittenAllowed(text)
  }
  return { ...action, text, enter }
}

/**
 * Keeps one terminal's writes in order while a hook decides: a later write (an Enter alone, say)
 * waits for an earlier hooked one instead of overtaking it. Unhooked writes with nothing pending
 * run at once.
 */
export class TerminalPluginHookOrder {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(handle: string, hooked: boolean, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(handle)
    if (!hooked && !previous) {
      return work()
    }
    const result = (previous ?? Promise.resolve()).catch(() => undefined).then(work)
    const tail = result.catch(() => undefined)
    this.tails.set(handle, tail)
    void tail.then(() => {
      if (this.tails.get(handle) === tail) {
        this.tails.delete(handle)
      }
    })
    return result
  }
}

/** Whether `agent.prompt.before` runs: prompts Orca, the CLI or a plugin submits, as for
 *  `terminal.send`; a person's own prompt is never held. */
export function agentPromptHookApplies(options: { inputSource?: TerminalInputSource }): boolean {
  return (
    (options.inputSource === undefined || options.inputSource === 'programmatic') &&
    pluginHookWanted('agent.prompt.before')
  )
}

/** `agent.prompt.before`, before the prompt is encoded for the agent. Throws PluginHookDeniedError. */
export async function runAgentPromptPluginHook(
  input: {
    handle: string
    prompt: string
    inputKind: Exclude<TerminalInputKind, 'query-reply'>
    agent: string | null
  },
  /** The caller's checks on the original prompt, run again on what a plugin wrote. */
  assertRewrittenAllowed: (prompt: string) => Promise<void>
): Promise<string> {
  const { prompt } = await runPluginHook(
    'agent.prompt.before',
    PLUGIN_HOOK_SPECS['agent.prompt.before'].payload,
    {
      agent: input.agent,
      terminalId: input.handle,
      prompt: input.prompt,
      inputKind: input.inputKind
    }
  )
  if (prompt !== input.prompt) {
    await assertRewrittenAllowed(prompt)
  }
  return prompt
}
