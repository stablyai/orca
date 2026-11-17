import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand
} from '../../../agent-hooks/installation/commands/managed-hook-command-matching'
import { readFileSync } from 'node:fs'
import {
  readHooksJson,
  readHooksJsonWithRaw
} from '../../../agent-hooks/installation/configuration/hooks-json-read'
import { removeConfigLeftEmpty } from '../../../agent-hooks/installation/configuration/hooks-json-empty-removal'
import { listGuestCodexAccountHomes } from '../../../codex-accounts/managed-homes/guest-codex-account-homes'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { listCodexAccountHomes } from '../../history/rollouts/codex-account-home-discovery'
import { getCodexConfigTomlPath, getConfigPath } from '../definitions/codex-hook-definition'
import { getCodexManagedScriptFileName } from '../definitions/codex-hook-identity'

/** Orca-managed account homes; unlike ~/.codex, no single Codex status reads all of them. */
export function listLocalCodexAccountHomes(): string[] {
  return [...new Set([...listCodexAccountHomes(), ...listGuestCodexAccountHomes()])]
}

/** Every local Codex home Orca may have hooked, whichever one the next pane launches on. */
export function listLocalCodexHookHomes(): string[] {
  return [
    ...new Set([
      getSystemCodexHomePath(),
      resolveOrcaManagedCodexHomePath(),
      ...listLocalCodexAccountHomes()
    ])
  ]
}

/** hooks.json files that still run Orca's Codex hook, across every local home. */
export function findCodexHooksFilesWithOrcaEntries(): string[] {
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  return listLocalCodexHookHomes()
    .map((home) => getConfigPath(home))
    .filter((hooksPath) =>
      Object.values(readHooksJson(hooksPath)?.hooks ?? {}).some(
        (definitions) =>
          Array.isArray(definitions) &&
          definitions.some((definition) =>
            hookDefinitionHasManagedCommand(definition, isManagedCommand)
          )
      )
    )
}

/** Every local Codex file Orca's hook install writes, for finding the backups it left. */
export function listLocalCodexHookConfigFiles(): string[] {
  return listLocalCodexHookHomes().flatMap((home) => [
    getConfigPath(home),
    getCodexConfigTomlPath(home)
  ])
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function isEmptyHooksFile(path: string): boolean {
  const { raw, config } = readHooksJsonWithRaw(path)
  if (raw === null || !config || Object.keys(config).some((key) => key !== 'hooks')) {
    return false
  }
  return config.hooks === undefined || Object.keys(config.hooks).length === 0
}

/** Uninstall only: hook files Orca's removal left with nothing in them. */
export function removeEmptiedCodexHookFiles(): void {
  for (const home of listLocalCodexHookHomes()) {
    const hooksPath = getConfigPath(home)
    if (isEmptyHooksFile(hooksPath)) {
      removeConfigLeftEmpty(hooksPath)
    }
    const tomlPath = getCodexConfigTomlPath(home)
    if (readTextOrNull(tomlPath)?.trim() === '') {
      removeConfigLeftEmpty(tomlPath)
    }
  }
}
