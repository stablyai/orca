// D12: while signed in to Orca, a saved Agent API key is also written to the user's personal Cloud
// secret of the same variable. Cloud secrets are write-only, so this is one way (desktop → account),
// and a key removed here leaves the account copy alone unless this computer wrote it and the user
// confirms. The ledger records which variables this computer wrote, per account; it holds no values.
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
import {
  CloudKeyLedger,
  namesWrittenBy,
  pendingOf,
  type LedgerEntry,
  type LedgerFile
} from './agent-api-key-cloud-ledger'

/** The signed-in account that can hold personal Cloud secrets, or null (signed out, no Cloud). */
export type AgentApiKeyCloudConnection = {
  accountId: string
  client: Pick<CloudSecretsClient, 'put' | 'remove'>
  /** False once the user signs in, out or switches account or team after this was read. */
  isCurrent: () => boolean
}

/**
 * Where the desktop stands with the Orca account. `unreachable`: signed in, but Orca can't be
 * reached now (offline, or the session refresh failed); rows keep their last-known state.
 */
export type AgentApiKeyCloudLink =
  | { kind: 'connected'; connection: AgentApiKeyCloudConnection }
  | { kind: 'unreachable'; accountId: string }
  | { kind: 'signed-out' }

/** Failures worth retrying on their own; anything else needs the user. */
const TRANSIENT: ReadonlySet<CloudSecretsErrorCode> = new Set([
  'unavailable',
  'timeout',
  'unknown',
  'unauthorized'
])

const PERSONAL = { scope: 'personal' } as const

type AgentApiKeyCloudSyncOptions = {
  ledgerPath: string
  /** Signed out (or no Orca Cloud): keys stay on this computer. */
  link: () => Promise<AgentApiKeyCloudLink>
  /** Unseals one vault key for a single write. */
  valueOf: (keyId: string) => Promise<string | null>
  /** The vault's keys now, to tell whether another key owns a variable's account copy. */
  listKeys: () => Promise<AgentApiKeySummary[]>
  /** Called when something now waits on Orca (it's unreachable, or a save is pending). */
  onWaiting?: () => void
  now?: () => number
}

export class AgentApiKeyCloudSync {
  private readonly book: CloudKeyLedger

  constructor(private readonly options: AgentApiKeyCloudSyncOptions) {
    this.book = new CloudKeyLedger(options.ledgerPath)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private ledger(): Promise<LedgerFile> {
    return this.book.read()
  }

  private setNames(accountId: string, names: Record<string, LedgerEntry>): Promise<void> {
    return this.book.setNames(accountId, names)
  }

  private async setPending(
    accountId: string,
    keyId: string,
    updatedAt: number | null
  ): Promise<void> {
    if (await this.book.setPending(accountId, keyId, updatedAt)) {
      this.options.onWaiting?.()
    }
  }

  /** The last link seen, so the reconnect check costs nothing while there's nothing to wait for. */
  lastLink: AgentApiKeyCloudLink['kind'] | null = null

  private async link(): Promise<AgentApiKeyCloudLink> {
    let link: AgentApiKeyCloudLink
    try {
      link = await this.options.link()
    } catch {
      link = { kind: 'signed-out' }
    }
    this.lastLink = link.kind
    if (link.kind === 'unreachable') {
      this.options.onWaiting?.()
    }
    return link
  }

  private async connection(): Promise<AgentApiKeyCloudConnection | null> {
    const link = await this.link()
    return link.kind === 'connected' ? link.connection : null
  }

  /** Saves waiting to reach the account, for any account (cheap: the ledger is cached). */
  hasPending(): boolean {
    return this.book.hasPending()
  }

  async state(keys: readonly AgentApiKeySummary[]): Promise<AgentApiKeysCloudState> {
    const link = await this.link()
    if (link.kind === 'signed-out') {
      return { signedIn: false, synced: [], managed: [] }
    }
    const accountId = link.kind === 'connected' ? link.connection.accountId : link.accountId
    const ledger = await this.ledger()
    if (link.kind === 'unreachable' && !ledger.accounts[accountId]) {
      // Never connected from here: nothing known to show, so this reads as signed out.
      return { signedIn: false, synced: [], managed: [] }
    }
    if (link.kind === 'connected' && !ledger.accounts[accountId]) {
      // Remember the account was connected, so a later offline spell shows its last-known state.
      await this.setNames(accountId, {})
    }
    const names = (await this.ledger()).accounts[accountId] ?? {}
    const pending = (await this.ledger()).pending?.[accountId] ?? {}
    const managed = keys.filter((key) => namesWrittenBy(names, key.id).length > 0)
    return {
      signedIn: true,
      ...(link.kind === 'unreachable' ? { unreachable: true } : {}),
      ...pendingOf(keys, pending),
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
    const link = await this.link()
    if (link.kind === 'signed-out' || key.hostScope.kind !== 'all') {
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
    if (link.kind === 'unreachable') {
      // Saved while signed in: it goes to the account as soon as Orca is reachable again.
      if ((await this.ledger()).accounts[link.accountId]) {
        await this.setPending(link.accountId, key.id, key.updatedAt)
      }
      return failed('unavailable')
    }
    const { connection } = link
    const retryLater = async (error: CloudSecretsErrorCode): Promise<AgentApiKeyCloudOutcome> => {
      await this.setPending(
        connection.accountId,
        key.id,
        TRANSIENT.has(error) ? key.updatedAt : null
      )
      return failed(error)
    }
    const owner = (await this.ledger()).accounts[connection.accountId]?.[key.envName]?.keyId
    if (
      !replace &&
      owner !== undefined &&
      owner !== key.id &&
      (await this.options.listKeys()).some((other) => other.id === owner)
    ) {
      return retryLater('desktop_key_conflict')
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
      return retryLater(logged('save', cloudSecretsFailureCode(error)))
    }
    // A sign-in or account switch mid-write: the token may have been another account's, so this
    // computer can't claim the variable (and must never later delete it on that claim).
    if (!connection.isCurrent()) {
      return failed(logged('save', 'unauthorized'))
    }
    const names = { ...(await this.ledger()).accounts[connection.accountId] }
    names[key.envName] = { keyId: key.id, keyUpdatedAt: key.updatedAt, syncedAt: this.now() }
    await this.setNames(connection.accountId, names)
    await this.setPending(connection.accountId, key.id, null)
    return { kind: 'synced' }
  }

  /**
   * Retries saves the user made while signed in that haven't reached the account. Only those keys,
   * only at the version that was saved: a key edited, rescoped or removed since is dropped.
   * Returns whether anything changed.
   */
  async flushPending(): Promise<boolean> {
    const connection = await this.connection()
    const pending = connection ? (await this.ledger()).pending?.[connection.accountId] : undefined
    if (!connection || !pending || Object.keys(pending).length === 0) {
      return false
    }
    const keys = await this.options.listKeys()
    let changed = false
    for (const [keyId, updatedAt] of Object.entries(pending)) {
      const key = keys.find((entry) => entry.id === keyId)
      if (!key || key.updatedAt !== updatedAt || !agentApiKeyCloudEligible(key)) {
        await this.setPending(connection.accountId, keyId, null)
        continue
      }
      const outcome = await this.push(key)
      changed ||= outcome.kind === 'synced'
      if (outcome.kind === 'failed' && TRANSIENT.has(outcome.error)) {
        break // Still unreachable: try again on the next check.
      }
    }
    return changed
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
        await this.setPending(connection.accountId, key.id, null)
      }
    }
  }
}

function logged(action: string, code: CloudSecretsErrorCode): CloudSecretsErrorCode {
  // Codes only: a message or body could quote the value.
  console.warn(`[agent-api-keys] could not ${action} in the Orca account: ${code}`)
  return code
}
