const MAX_ENV_DELETE_KEYS = 1_024
const MAX_PERSISTENCE_FIELD_BYTES = 64 * 1024

export type RelayPtyV2EntryBasics = {
  attachIdentity?: { paneKey?: string; tabId?: string }
  envToDelete?: string[]
  gitCredentialPromptGuarded: boolean
}

export function normalizeRelayPtyV2EntryBasics(
  entry: Record<string, unknown>
): RelayPtyV2EntryBasics {
  return {
    ...normalizeAttachIdentity(entry.attachIdentity),
    ...normalizeEnvToDelete(entry.envToDelete),
    gitCredentialPromptGuarded: normalizeGitCredentialPromptGuarded(
      entry.gitCredentialPromptGuarded
    )
  }
}

function normalizeAttachIdentity(value: unknown): Pick<RelayPtyV2EntryBasics, 'attachIdentity'> {
  if (value === undefined) {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PTY persistence attach identity is invalid')
  }
  const identity = value as Record<string, unknown>
  assertExactKeys(identity, ['paneKey', 'tabId'], 'attachIdentity')
  const paneKey = optionalString(identity.paneKey, 'attachIdentity.paneKey')
  const tabId = optionalString(identity.tabId, 'attachIdentity.tabId')
  return paneKey === undefined && tabId === undefined ? {} : { attachIdentity: { paneKey, tabId } }
}

function normalizeEnvToDelete(value: unknown): Pick<RelayPtyV2EntryBasics, 'envToDelete'> {
  if (value === undefined) {
    return {}
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_ENV_DELETE_KEYS ||
    !value.every((key) => typeof key === 'string' && key.length > 0)
  ) {
    throw new Error('PTY persistence envToDelete is invalid')
  }
  for (const key of value) {
    assertFieldSize('envToDelete', key)
  }
  return { envToDelete: value }
}

function normalizeGitCredentialPromptGuarded(value: unknown): boolean {
  if (value === undefined) {
    return false
  }
  if (typeof value !== 'boolean') {
    throw new Error('PTY persistence git credential guard is invalid')
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`PTY persistence field "${field}" must be a string`)
  }
  assertFieldSize(field, value)
  return value
}

function assertFieldSize(field: string, value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_PERSISTENCE_FIELD_BYTES) {
    throw new Error(`PTY persistence field "${field}" exceeds ${MAX_PERSISTENCE_FIELD_BYTES} bytes`)
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string
): void {
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error(`${name} contains an unknown field`)
  }
}
