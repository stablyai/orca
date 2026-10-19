import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { computeTrustKey, moveHookTrustEntries, type CodexTrustEntry } from './config-toml-trust'

type HooksByEvent = Record<string, HookDefinition[]>

export type CodexUserHookTrustMove = {
  oldKey: string
  newKey: string
  command: string
}

function entriesByHookObject(
  sourcePath: string,
  hooksByEvent: HooksByEvent
): Map<HookCommandConfig, CodexTrustEntry> {
  const result = new Map<HookCommandConfig, CodexTrustEntry>()
  for (const [eventName, definitions] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      if (!Array.isArray(definition.hooks)) {
        return
      }
      definition.hooks.forEach((hook, handlerIndex) => {
        const entry = createCodexHookTrustEntry(
          sourcePath,
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (entry) {
          result.set(hook, entry)
        }
      })
    })
  }
  return result
}

export function getMovedCodexUserHookTrust(
  sourcePath: string,
  beforeHooks: HooksByEvent,
  afterHooks: HooksByEvent
): CodexUserHookTrustMove[] {
  const before = entriesByHookObject(sourcePath, beforeHooks)
  const after = entriesByHookObject(sourcePath, afterHooks)
  const moves: CodexUserHookTrustMove[] = []
  for (const [hook, oldEntry] of before) {
    const newEntry = after.get(hook)
    if (!newEntry) {
      continue
    }
    const oldKey = computeTrustKey(oldEntry)
    const newKey = computeTrustKey(newEntry)
    if (oldKey !== newKey) {
      moves.push({ oldKey, newKey, command: oldEntry.command })
    }
  }
  return moves
}

/**
 * Writes hooks.json, then moves the trust of every hook the write shifted to
 * its new key, verbatim. Needs no Codex session, so no removal waits on one.
 */
export function mutateRealHomeHooksPreservingUserTrust(args: {
  /** Every spelling Codex may key this file by (as spelled, and resolved). */
  sourcePaths: readonly string[]
  tomlPath: string
  beforeHooks: HooksByEvent
  afterHooks: HooksByEvent
  writeHooks: () => void
}): void {
  const moves = args.sourcePaths.flatMap((sourcePath) =>
    getMovedCodexUserHookTrust(sourcePath, args.beforeHooks, args.afterHooks)
  )
  args.writeHooks()
  try {
    moveHookTrustEntries(args.tomlPath, moves)
  } catch (error) {
    // Why no rollback: the hooks write is what was asked for; Codex lists the
    // moved hooks for review, which the user can approve there.
    console.warn('[codex-user-hook-trust] could not move shifted user hook trust:', error)
  }
}
