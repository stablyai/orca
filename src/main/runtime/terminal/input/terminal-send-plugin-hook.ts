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

/** How a write joins its terminal's hook order: `hooked` waits for earlier decisions and holds
 *  later writes while its own runs; `ordered` waits but holds nothing; `bypass` (a person's
 *  input, an interrupt) never waits. */
export type TerminalHookOrderKind = 'hooked' | 'ordered' | 'bypass'

export function terminalHookOrderKind(
  hooked: boolean,
  action: { interrupt?: boolean },
  options: { inputKind?: TerminalInputKind; inputSource?: TerminalInputSource }
): TerminalHookOrderKind {
  if (hooked) {
    return 'hooked'
  }
  const human = options.inputSource !== undefined && options.inputSource !== 'programmatic'
  return human || action.interrupt === true || options.inputKind === 'query-reply'
    ? 'bypass'
    : 'ordered'
}

/**
 * Keeps one terminal's writes in the order they were asked for while a hook decides: a later
 * write (an Enter alone, say) waits for an earlier hooked decision instead of overtaking it.
 * Only the decision holds the order; delivery (which may wait on a permission prompt) does not.
 */
export class TerminalPluginHookOrder {
  private readonly decisions = new Map<string, Promise<unknown>>()

  run<A, T>(
    handle: string,
    kind: TerminalHookOrderKind,
    value: A,
    decide: (value: A) => Promise<A>,
    deliver: (value: A) => Promise<T>
  ): Promise<T> {
    const previous = this.decisions.get(handle)
    if (kind === 'bypass' || (kind === 'ordered' && !previous)) {
      return deliver(value)
    }
    const waited = (previous ?? Promise.resolve()).catch(() => undefined)
    const decided = kind === 'hooked' ? waited.then(() => decide(value)) : waited.then(() => value)
    if (kind === 'hooked') {
      const tail = decided.then(
        () => undefined,
        () => undefined
      )
      this.decisions.set(handle, tail)
      void tail.then(() => {
        if (this.decisions.get(handle) === tail) {
          this.decisions.delete(handle)
        }
      })
    }
    return decided.then(deliver)
  }
}
