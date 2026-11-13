// Which saved servers are PAIRED Orca Cloud workspaces (PAIRED-AWARE). Opening a cloud workspace this
// desktop didn't create (another device, a teammate's, a link, or one started from a GitHub-only repo)
// pairs this device as a "<name> (cloud)" server and records sandbox -> environment in the bindings
// file. The runtime catalog marks those servers so every Orca Cloud check treats them like this
// desktop's own sandboxes.
//
// Held in memory: the pairings module reports every bindings read and write here (no sync file reads
// on the main thread), and the catalog republishes when the set changes.
import { join } from 'node:path'
import { getOrcaProfileIndexGeneration } from '../orca-profiles/profile-index-generation'

export const CLOUD_PAIRING_BINDINGS_FILE = 'cloud-workspaces-environments.json'

export function cloudPairingBindingsPath(userDataPath: string): string {
  return join(userDataPath, CLOUD_PAIRING_BINDINGS_FILE)
}

type Pairing = { sandboxId: string; accountId: string | null }

let pairingByEnvironment: ReadonlyMap<string, Pairing> = new Map()
let readActiveAccountId: () => string | null = () => null
let cachedAccount: { generation: number; accountId: string | null } | null = null

/**
 * PAIRED-ACCOUNT-FILTER: the active Orca account ("org:<id>" or "user:<id>", the same id the
 * bindings are stamped with). Set once at startup by the pairings module.
 */
export function setCloudPairingActiveAccountReader(read: () => string | null): void {
  readActiveAccountId = read
  cachedAccount = null
}

/**
 * The active account, read once per profile-index write (sign-in, sign-out, team or profile
 * switch): the reader touches disk, and this runs on every paired status poll, wake and restart.
 */
function activeAccountId(): string | null {
  const generation = getOrcaProfileIndexGeneration()
  if (cachedAccount?.generation !== generation) {
    cachedAccount = { generation, accountId: readActiveAccountId() }
  }
  return cachedAccount.accountId
}

/** The bindings as last read or written (sandbox id -> binding). Returns true on a change. */
export function noteCloudPairingBindings(
  bindings: Readonly<Record<string, { environmentId: string; accountId?: string | null }>>
): boolean {
  const next = new Map<string, Pairing>()
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    if (binding?.environmentId) {
      next.set(binding.environmentId, { sandboxId, accountId: binding.accountId ?? null })
    }
  }
  const changed =
    next.size !== pairingByEnvironment.size ||
    [...next].some(([environmentId, pairing]) => {
      const before = pairingByEnvironment.get(environmentId)
      return before?.sandboxId !== pairing.sandboxId || before.accountId !== pairing.accountId
    })
  pairingByEnvironment = next
  return changed
}

/**
 * A binding this account may act through: stamped with the active account, or unstamped (saved
 * before LC-1; the prune stamps it once the active team's list shows it). Another account's binding
 * never resolves: the control plane would refuse it with a confusing error.
 */
export function isCloudPairingForActiveAccount(accountId: string | null): boolean {
  return accountId === null || accountId === activeAccountId()
}

/** Paired environment id -> its sandbox id, for the active account only (PAIRED-ACCOUNT-FILTER). */
export function cloudPairedSandboxesByEnvironment(): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const [environmentId, pairing] of pairingByEnvironment) {
    if (isCloudPairingForActiveAccount(pairing.accountId)) {
      result.set(environmentId, pairing.sandboxId)
    }
  }
  return result
}

/**
 * Every environment bound to a cloud pairing, any account: the catalog marks them all as Orca Cloud
 * (with the account each belongs to) so the sidebar can scope another team's out, as for owned rows.
 */
export function cloudPairedEnvironmentIds(): ReadonlySet<string> {
  return new Set(pairingByEnvironment.keys())
}

/** The account a paired environment's binding was stamped with, or null (unstamped / not paired). */
export function cloudPairedAccountId(environmentId: string): string | null {
  return pairingByEnvironment.get(environmentId)?.accountId ?? null
}

/**
 * The catalog entry a window sees: a paired server is marked Orca Cloud, with the account its
 * binding was made under, so the sidebar scopes another team's out like its owned rows.
 */
export function withCloudPairingMark<T extends { id: string }>(
  environment: T
): T & { orcaCloudPaired?: true; orcaCloudPairedAccountId?: string } {
  const pairing = pairingByEnvironment.get(environment.id)
  if (!pairing) {
    return environment
  }
  return {
    ...environment,
    orcaCloudPaired: true as const,
    ...(pairing.accountId ? { orcaCloudPairedAccountId: pairing.accountId } : {})
  }
}
