import { existsSync } from 'node:fs'
import {
  createManagedCommandMatcher,
  removeManagedCommands
} from '../../../agent-hooks/installation/commands/managed-hook-command-matching'
import { readHooksJson } from '../../../agent-hooks/installation/configuration/hooks-json-read'
import type { CodexHookHashes } from '../../trust/hooks/codex-hook-trust-derivation'
import { removeRuntimeManagedHookTrustEntries } from '../../trust/hooks/codex-hook-trust-cleanup'
import { getConfigPath, writeCodexHooksJson } from '../definitions/codex-hook-definition'
import { getCodexManagedScriptFileName } from '../definitions/codex-hook-identity'
import type { CodexHookPassEffects } from './codex-hook-install-effects'

/**
 * Removes Orca's managed hooks and their trust from one home and keeps the user's own hooks.
 * Needs no system source, so it still works when ~/.codex/hooks.json is unreadable.
 * Returns false when the home's hooks.json cannot be parsed.
 */
export function stripCodexManagedHooksFromHome(
  runtimeHomePath: string,
  codexHashes: readonly CodexHookHashes[]
): boolean {
  const configPath = getConfigPath(runtimeHomePath)
  const configExists = existsSync(configPath)
  const config = readHooksJson(configPath)
  if (!config) {
    return false
  }
  const nextHooks = { ...config.hooks }
  // Match by filename to remove older builds' hooks even after script relocation.
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  if (configExists) {
    // Strip top-level plugin metadata that makes Codex reject hooks.json.
    writeCodexHooksJson(configPath, nextHooks)
  }
  removeRuntimeManagedHookTrustEntries(configPath, codexHashes, runtimeHomePath)
  return true
}

/** The strip as a pass result, for Off landing during a launch's install. */
export function stripCodexManagedHookEffects(
  runtimeHomePath: string,
  codexHashes: readonly CodexHookHashes[]
): CodexHookPassEffects {
  return stripCodexManagedHooksFromHome(runtimeHomePath, codexHashes)
    ? { kind: 'written', complete: true }
    : {
        kind: 'status',
        // A malformed runtime file must not skip legacy cleanup after disabling.
        cleanupFirst: true,
        status: {
          agent: 'codex',
          state: 'error',
          configPath: getConfigPath(runtimeHomePath),
          managedHooksPresent: false,
          detail: 'Could not parse Codex hooks.json'
        }
      }
}
