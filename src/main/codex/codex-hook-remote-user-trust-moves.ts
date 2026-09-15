import type { HookDefinition } from '../agent-hooks/installer-utils'
import { createCodexHookTrustEntry, getCodexHookTrustSignature } from './codex-hook-identity'
import type { CODEX_EVENTS } from './codex-hook-definition'
import {
  computeTrustKey,
  type CodexHookTrustKeyMove,
  type CodexTrustEntry
} from './config-toml-trust'

// Why: repeated remote installs may find Orca before or after user hooks. Match
// user content across cleanup so only approvals whose real index changed move.
export function collectPrependedRemoteUserTrustMoves(
  sourcePath: string,
  eventName: (typeof CODEX_EVENTS)[number],
  current: readonly HookDefinition[],
  cleaned: readonly HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): CodexHookTrustKeyMove[] {
  const oldEntriesBySignature = new Map<string, CodexTrustEntry[]>()
  current.forEach((definition, groupIndex) => {
    const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
    hooks.forEach((hook, handlerIndex) => {
      if (isManagedCommand(hook.command)) {
        return
      }
      const entry = createCodexHookTrustEntry(
        sourcePath,
        eventName,
        groupIndex,
        handlerIndex,
        definition,
        hook
      )
      if (!entry) {
        return
      }
      const signature = getCodexHookTrustSignature(entry)
      const entries = oldEntriesBySignature.get(signature) ?? []
      entries.push(entry)
      oldEntriesBySignature.set(signature, entries)
    })
  })

  const moves: CodexHookTrustKeyMove[] = []
  cleaned.forEach((definition, cleanedGroupIndex) => {
    const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
    hooks.forEach((hook, handlerIndex) => {
      const nextEntry = createCodexHookTrustEntry(
        sourcePath,
        eventName,
        cleanedGroupIndex + 1,
        handlerIndex,
        definition,
        hook
      )
      if (!nextEntry) {
        return
      }
      const oldEntries = oldEntriesBySignature.get(getCodexHookTrustSignature(nextEntry))
      const oldEntry = oldEntries?.shift()
      if (!oldEntry) {
        return
      }
      moves.push({ fromKey: computeTrustKey(oldEntry), toKey: computeTrustKey(nextEntry) })
    })
  })
  return moves
}
