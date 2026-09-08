import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../shared/secure-file'
import {
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  type AiVaultSearchSettings
} from '../shared/ai-vault-search-settings'
import { SessionSearchConfigureSchema } from '../shared/ai-vault-search-contract'

const POLICY_FILE_VERSION = 1
const POLICY_FILE_MAX_BYTES = 8192

export const SESSION_SEARCH_POLICY_RECOVERY_HINT =
  'Run `orca search --clear-index` against this host to reset the index and policy.'

/** Refuses a path another account could have substituted for the real one. */
export function assertOwnedSearchPath(path: string, directory: boolean): void {
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('Unsafe search owner path.')
  }
}

function policyPath(directory: string): string {
  return join(directory, 'policy.json')
}

/** Throws when the recorded policy cannot be vouched for; absent reads as consent-off. */
export function readSessionSearchOwnerPolicy(
  directory: string,
  home: string
): AiVaultSearchSettings {
  const file = policyPath(directory)
  if (!existsSync(file)) {
    return { ...DEFAULT_AI_VAULT_SEARCH_SETTINGS }
  }
  assertOwnedSearchPath(file, false)
  if (statSync(file).size > POLICY_FILE_MAX_BYTES) {
    throw new Error('Search policy exceeds its size limit.')
  }
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  if (saved.home !== home || saved.version !== POLICY_FILE_VERSION) {
    throw new Error('Search source configuration changed; host policy must be reviewed.')
  }
  const policy = SessionSearchConfigureSchema.parse(saved.policy)
  if (typeof policy.enabled !== 'boolean' || policy.historyDays === undefined) {
    throw new Error('Invalid search policy.')
  }
  return {
    enabled: policy.enabled,
    historyDays: policy.historyDays,
    ...(policy.paused ? { paused: true } : {})
  }
}

export function writeSessionSearchOwnerPolicy(
  directory: string,
  home: string,
  policy: AiVaultSearchSettings
): void {
  if (
    !writeDurableSecureJsonFile(policyPath(directory), {
      home,
      version: POLICY_FILE_VERSION,
      policy
    })
  ) {
    throw new Error('Could not secure the host search policy.')
  }
}
