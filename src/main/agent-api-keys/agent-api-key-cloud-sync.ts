// D12: while signed in to Orca, a saved Agent API key is also written to the user's personal Cloud
// secret of the same variable. Cloud secrets are write-only, so this is one way (desktop → account),
// and a key removed here leaves the account copy alone unless this computer wrote it and the user
// confirms. The ledger records which variables this computer wrote, per account; it holds no values.
import { readFile } from 'node:fs/promises'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
import type { AgentApiKeySummary } from '../../shared/agent-api-keys/agent-api-key-catalog'
import {
  agentApiKeyCloudEligible,
  type AgentApiKeyCloudOutcome,
  type AgentApiKeysCloudState
} from '../../shared/agent-api-keys/agent-api-key-cloud'
import { cloudSecretValueError } from '../../shared/cloud-secrets/cloud-secret-rules'
import type { CloudSecretsErrorCode } from '../../shared/cloud-secrets/cloud-secrets-wire'
import {
  cloudSecretsFailureCode,
  type CloudSecretsClient
} from '../cloud-secrets/cloud-secrets-client'

/** The signed-in account that can hold personal Cloud secrets, or null (signed out, no Cloud). */
export type AgentApiKeyCloudConnection = {
  accountId: string
  client: Pick<CloudSecretsClient, 'put' | 'remove'>
  /** False once the user signs in, out or switches account or team after this was read. */
  isCurrent: () => boolean
}

type LedgerEntry = {
  /** The vault key whose value was written. */
  keyId: string
  /** That key's `updatedAt` when it was written, so a later edit that failed to sync isn't "synced". */
  keyUpdatedAt: number
  syncedAt: number
}

type LedgerFile = {
  version: 1
  /** accountId → variable → what this computer wrote there. */
  accounts: Record<string, Record<string, LedgerEntry>>
}

const MAX_LEDGER_BYTES = 256 * 1024
const PERSONAL = { scope: 'personal' } as const

function isEntry(value: unknown): value is LedgerEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'keyId' in value &&
    'keyUpdatedAt' in value &&
    'syncedAt' in value &&
    typeof value.keyId === 'string' &&
    typeof value.keyUpdatedAt === 'number' &&
    typeof value.syncedAt === 'number'
  )
}

function parseLedger(text: string): LedgerFile {
  const ledger: LedgerFile = { version: 1, accounts: {} }
  if (text.length > MAX_LEDGER_BYTES) {
    return ledger
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return ledger
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('accounts' in parsed) ||
    typeof parsed.accounts !== 'object' ||
    parsed.accounts === null
  ) {
    return ledger
  }
  for (const [accountId, names] of Object.entries(parsed.accounts)) {
    if (typeof names !== 'object' || names === null) {
      continue
    }
    const kept: Record<string, LedgerEntry> = {}
    for (const [name, entry] of Object.entries(names)) {
      if (isEntry(entry)) {
        kept[name] = entry
      }
    }
    ledger.accounts[accountId] = kept
  }
  return ledger
}

export type AgentApiKeyCloudSyncOptions = {
  ledgerPath: string
  /** Null when signed out of Orca or Orca Cloud isn't offered: keys then stay on this computer. */
  connection: () => Promise<AgentApiKeyCloudConnection | null>
  /** Unseals one vault key for a single write. */
  valueOf: (keyId: string) => Promise<string | null>
  /** The vault's keys now, to tell whether another key owns a variable's account copy. */
  listKeys: () => Promise<AgentApiKeySummary[]>
  now?: () => number
}

/** The variables `keyId` wrote to the account (more than one after a rename). */
function namesWrittenBy(names: Record<string, LedgerEntry>, keyId: string): string[] {
  return Object.entries(names)
    .filter(([, entry]) => entry.keyId === keyId)
    .map(([name]) => name)
}

export class AgentApiKeyCloudSync {
  private cached: LedgerFile | null = null

  constructor(private readonly options: AgentApiKeyCloudSyncOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async ledger(): Promise<LedgerFile> {
    if (this.cached) {
      return this.cached
    }
    let text = ''
    try {
      text = await readFile(this.options.ledgerPath, 'utf8')
    } catch {
      // Missing or unreadable: nothing was synced from here that we can prove, so remove nothing.
    }
    return (this.cached = parseLedger(text))
  }

  private async setNames(accountId: string, names: Record<string, LedgerEntry>): Promise<void> {
    const ledger = await this.ledger()
    const next: LedgerFile = { ...ledger, accounts: { ...ledger.accounts, [accountId]: names } }
    writeSecureFile(this.options.ledgerPath, JSON.stringify(next, null, 2))
    this.cached = next
  }

  private async connection(): Promise<AgentApiKeyCloudConnection | null> {
    try {
      return await this.options.connection()
    } catch {
      return null
    }
  }

  async state(keys: readonly AgentApiKeySummary[]): Promise<AgentApiKeysCloudState> {
    const connection = await this.connection()
    if (!connection) {
      return { signedIn: false, synced: [], managed: [] }
    }
    const names = (await this.ledger()).accounts[connection.accountId] ?? {}
    const managed = keys.filter((key) => namesWrittenBy(names, key.id).length > 0)
    return {
      signedIn: true,
      managed: managed.map((key) => key.id),
      synced: managed
        .filter((key) => {
          const entry = names[key.envName]
          return (
            agentApiKeyCloudEligible(key) &&
            entry?.keyId === key.id &&
            entry.keyUpdatedAt === key.updatedAt
          )
        })
        .map((key) => key.id)
    }
  }

  /**
   * Writes one vault key to the personal Cloud secret of its variable. Skips (no error) when signed
   * out or when the key is scoped to some hosts; a variable the proxy can't swap is refused, because
   * the workspace would hold it in full. When another vault key (another agent's) wrote that
   * variable, only an explicit `replace` overwrites it.
   */
  async push(
    key: AgentApiKeySummary,
    { replace = false }: { replace?: boolean } = {}
  ): Promise<AgentApiKeyCloudOutcome> {
    const connection = await this.connection()
    if (!connection || key.hostScope.kind !== 'all') {
      return { kind: 'skipped' }
    }
    const failed = (error: CloudSecretsErrorCode): AgentApiKeyCloudOutcome => ({
      kind: 'failed',
      error,
      keyId: key.id
    })
    if (!agentApiKeyCloudEligible(key)) {
      return failed('not_swappable')
    }
    const owner = (await this.ledger()).accounts[connection.accountId]?.[key.envName]?.keyId
    if (
      !replace &&
      owner !== undefined &&
      owner !== key.id &&
      (await this.options.listKeys()).some((other) => other.id === owner)
    ) {
      return failed('desktop_key_conflict')
    }
    const value = await this.options.valueOf(key.id)
    if (!value) {
      return failed('not_found')
    }
    const valueError = cloudSecretValueError(key.envName, value)
    if (valueError) {
      return failed(valueError)
    }
    try {
      await connection.client.put(PERSONAL, key.envName, value)
    } catch (error) {
      return failed(logged('save', cloudSecretsFailureCode(error)))
    }
    // A sign-in or account switch mid-write: the token may have been another account's, so this
    // computer can't claim the variable (and must never later delete it on that claim).
    if (!connection.isCurrent()) {
      return failed(logged('save', 'unauthorized'))
    }
    const names = { ...(await this.ledger()).accounts[connection.accountId] }
    names[key.envName] = { keyId: key.id, keyUpdatedAt: key.updatedAt, syncedAt: this.now() }
    await this.setNames(connection.accountId, names)
    return { kind: 'synced' }
  }

  /** Records a write of `key` made elsewhere (the cloud workspace setup's "Save to your Orca account"). */
  async record(key: AgentApiKeySummary): Promise<void> {
    const connection = await this.connection()
    if (!connection || !agentApiKeyCloudEligible(key)) {
      return
    }
    const names = { ...(await this.ledger()).accounts[connection.accountId] }
    names[key.envName] = { keyId: key.id, keyUpdatedAt: key.updatedAt, syncedAt: this.now() }
    await this.setNames(connection.accountId, names)
  }

  /**
   * Before the vault removes `key`: with `fromAccount`, deletes every account copy this computer
   * wrote from this key (its current and any earlier variable). Returns an error code to abort the
   * removal (nothing changed), or the variables to forget once the vault has removed the key.
   */
  async beforeRemove(
    key: AgentApiKeySummary,
    fromAccount: boolean
  ): Promise<
    | { ok: true; removedFromAccount: boolean; forget: () => Promise<void> }
    | { ok: false; error: CloudSecretsErrorCode }
  > {
    const connection = await this.connection()
    if (!connection) {
      return fromAccount
        ? { ok: false, error: 'unauthorized' }
        : { ok: true, removedFromAccount: false, forget: async () => {} }
    }
    const written = namesWrittenBy(
      (await this.ledger()).accounts[connection.accountId] ?? {},
      key.id
    )
    if (fromAccount && written.length === 0) {
      // Nothing this computer wrote: never delete a secret the user made elsewhere.
      return { ok: false, error: 'not_found' }
    }
    if (fromAccount) {
      for (const name of written) {
        if (!connection.isCurrent()) {
          return { ok: false, error: logged('remove', 'unauthorized') }
        }
        try {
          await connection.client.remove(PERSONAL, name)
        } catch (error) {
          const code = cloudSecretsFailureCode(error)
          // Already gone from the account is what the user asked for.
          if (code !== 'not_found') {
            return { ok: false, error: logged('remove', code) }
          }
        }
      }
    }
    return {
      ok: true,
      removedFromAccount: fromAccount,
      // Removed, or the user chose to keep it there: either way this computer stops managing it.
      forget: async () => {
        const { [connection.accountId]: names = {} } = (await this.ledger()).accounts
        const rest = Object.fromEntries(
          Object.entries(names).filter(([, entry]) => entry.keyId !== key.id)
        )
        await this.setNames(connection.accountId, rest)
      }
    }
  }
}

function logged(action: string, code: CloudSecretsErrorCode): CloudSecretsErrorCode {
  // Codes only: a message or body could quote the value.
  console.warn(`[agent-api-keys] could not ${action} in the Orca account: ${code}`)
  return code
}
