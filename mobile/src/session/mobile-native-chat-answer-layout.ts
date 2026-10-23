import type { AskPrompt } from '../../../src/shared/native-chat-ask'

export function askOwnsComposer(
  ask: AskPrompt | null | undefined,
  requiresTerminal: boolean,
  collapsed: boolean,
  micActive: boolean | undefined
): boolean {
  return ask != null && !requiresTerminal && !collapsed && !micActive
}
