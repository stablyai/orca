import { PLUGIN_HOOK_SPECS } from '../../../../shared/plugins/events/plugin-hook-payloads'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { pluginHookWanted, runPluginHook } from '../../../plugins/hooks/plugin-hook-dispatch'

type TerminalSendAction = { text?: string; enter?: boolean; interrupt?: boolean }

/**
 * Runs the `terminal.send` plugin hook, or returns null when no plugin lists it (the usual case,
 * which then adds no await). Runs on the host handling the send, before the bytes go to the PTY,
 * so SSH and WSL terminals are decided here too. Throws PluginHookDeniedError on a deny.
 */
export function terminalSendPluginHook(
  handle: string,
  action: TerminalSendAction,
  inputKind: TerminalInputKind
): Promise<TerminalSendAction> | null {
  // Why skip query replies and bare keys: they are the terminal answering, or Enter/Ctrl+C alone.
  if (
    inputKind === 'query-reply' ||
    typeof action.text !== 'string' ||
    action.text.length === 0 ||
    !pluginHookWanted('terminal.send')
  ) {
    return null
  }
  return runPluginHook('terminal.send', PLUGIN_HOOK_SPECS['terminal.send'].payload, {
    terminalId: handle,
    text: action.text,
    enter: action.enter === true,
    inputKind
  }).then(({ text, enter }) => ({ ...action, text, enter }))
}
