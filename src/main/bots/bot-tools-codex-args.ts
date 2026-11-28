// The Codex Arguments a bot's chats launch app-server with, which a Tools check must load the same.
import { createHash } from 'node:crypto'
import { codexStructuredLaunchArgs } from '../codex/structured/launch/codex-structured-launch-args'
import { structuredAgentConfiguredArgs } from '../native-chat/agent-launch/structured-agent-configured-args'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'

type Settings = Parameters<typeof structuredAgentConfiguredArgs>[1]

/** A chat's app-server root options from Codex Arguments, or why a chat can't launch with them. */
export type CodexChatArgs = { args: readonly string[] } | { invalid: string }

/** The root options a chat's app-server gets from Codex Arguments; invalid as a chat refuses them. */
export function codexChatAppServerArgs(settings: Settings): CodexChatArgs {
  try {
    return { args: codexStructuredLaunchArgs(structuredAgentConfiguredArgs('codex', settings)) }
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * What a Codex bot's Tools check ran with, opaque: a reader compares it to know a check from before
 * a change is old, and learns nothing of the Arguments themselves. Invalid differs from empty.
 */
export function codexToolCheckBasis(chatArgs: CodexChatArgs | undefined): string {
  const shown = !chatArgs ? { args: [] } : chatArgs
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 16)
}

/** Calls `changed` when the Codex Arguments a Tools check loads change; the return stops it. */
export function watchCodexToolCheckArgs(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'> | null,
  changed: () => void
): () => void {
  if (!store?.getSettings || !store.onSettingsChanged) {
    return () => {}
  }
  let previous = codexToolCheckBasis(codexChatAppServerArgs(store.getSettings()))
  return store.onSettingsChanged((_updates, settings) => {
    const next = codexToolCheckBasis(codexChatAppServerArgs(settings))
    if (next !== previous) {
      previous = next
      changed()
    }
  })
}

/** What a check of `agent` is admitted under now: Codex's Arguments and their basis; none else. */
export function codexCheckAdmission(
  agent: string,
  settings: Settings
): { chatArgs?: CodexChatArgs; checkBasis?: string } {
  if (agent !== 'codex') {
    return {}
  }
  const chatArgs = codexChatAppServerArgs(settings)
  return { chatArgs, checkBasis: codexToolCheckBasis(chatArgs) }
}
