import {
  createManagedCommandMatcher,
  readHooksJsonWithRaw,
  removeManagedCommands,
  writeHooksJson,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { assertHooksJsonGeneration } from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { getRealHomeCodexHookHome, type CodexHookHome } from './codex-hook-orca-approvals'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-moves'

/**
 * The opt-out's removal of every Orca entry from the real ~/.codex/hooks.json (or another
 * home Orca edits in place), moving user approvals that shift; the caller removes Orca's own approvals.
 */
export function sweepRealHomeCodexHook(
  home: CodexHookHome = getRealHomeCodexHookHome()
): 'removed' | 'unavailable' {
  const { hooksJsonPath } = home
  // Why: single read — the pre-write generation guard must compare against
  // the exact bytes this sweep's parse came from.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config) {
    // Why: a failed or malformed read proves no cleanup; keep the managed lane
    // until a later pass can inspect and remove the real-home entry.
    return 'unavailable'
  }
  if (!config.hooks || previousRaw === null) {
    return 'removed'
  }
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  let removedAny = false
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (
      cleaned.length !== definitions.length ||
      cleaned.some((definition, index) => definition !== definitions[index])
    ) {
      removedAny = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  if (removedAny) {
    const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
    mutateRealHomeHooksPreservingUserTrust({
      sourcePaths: home.keySourcePaths,
      tomlPath: home.tomlPath,
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
      }
    })
  }
  return 'removed'
}
