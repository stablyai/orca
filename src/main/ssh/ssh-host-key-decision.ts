/** Keep host-key policy independent of handshake wiring and inject trust evidence for deterministic decisions. */
import { isEphemeralRuntimeSshOwner } from '../../shared/managed-orcad-ssh-owner'
import type { SshTargetOwner } from '../../shared/ssh-types'
import type { KnownHostsOutcome } from './config/ssh-known-hosts'

/** Prompt is reserved for future UI; current decisions never produce it. */
type HostKeyAction = 'accept' | 'accept-and-remember' | 'reject' | 'prompt'

export type HostKeyDecision = {
  action: HostKeyAction
  outcome: KnownHostsOutcome
  /** Name the disagreeing source so guidance points to a remedy that can work. */
  disagreeingSource?: 'orca-store' | 'known-hosts'
  reason?: string
}

export type HostKeyPolicy =
  | { kind: 'standard' }
  /** Ephemeral VMs rotate keys each launch; accept first contact without accumulating stale trust. */
  | { kind: 'ephemeral' }

export function hostKeyPolicyForOwner(owner: SshTargetOwner | undefined): HostKeyPolicy {
  return isEphemeralRuntimeSshOwner(owner) ? { kind: 'ephemeral' } : { kind: 'standard' }
}

export type HostKeyDecisionInput = {
  knownHostsOutcome: KnownHostsOutcome
  storeOutcome: 'match' | 'mismatch' | 'unknown-type-known-host' | 'unknown'
  /** Effective `StrictHostKeyChecking`; anything unrecognised is treated as `ask`. */
  strictHostKeyChecking: string
  policy: HostKeyPolicy
  /** Suppressed site config may hide strict policy: refuse new durable-host trust while retaining already-known matches. */
  siteConfigSuppressed: boolean
  /** Existing unreadable known_hosts may hide a mismatch. Follow ssh by connecting, but never persist trust from incomplete evidence. */
  knownHostsUnreadable: boolean
  displayHost: string
  port: number
  /** Name the store file for changed store-only trust; ssh-keygen cannot remove entries absent from known_hosts. */
  hostKeyStoreFile?: string
}

/** OpenSSH 10.2p1 -R needs [host]:port off port 22; bare host removes only its port 22 entry and -R has no port flag. */
function keygenRemoveTarget(displayHost: string, port: number): string {
  return port === 22 ? displayHost : `'[${displayHost}]:${port}'`
}

/** OpenSSH 10.2p1 ssh -G renders yes as true and no/off as false; ask/accept-new remain unchanged. Match normalized values or explicit strict policy silently falls through. */
const STRICT_VALUES = new Set(['true', 'yes', 'always'])
const LAX_VALUES = new Set(['false', 'no', 'off'])

const CHANGED_KEY_HINT =
  'If you rebuilt or reprovisioned this machine, remove the saved key and reconnect.'

/** Store-only rotations require a concrete file path; known_hosts remedies cannot clear them. */
function changedKeyHint(hostKeyStoreFile: string | undefined): string {
  return hostKeyStoreFile
    ? `If you rebuilt or reprovisioned this machine, remove its entry from ${hostKeyStoreFile} and reconnect.`
    : CHANGED_KEY_HINT
}

/** Avoid auth-failure phrases consumed by the reconnect ladder or permanent refusal would retry indefinitely. */
function rejection(displayHost: string, detail: string): string {
  return `Host key verification failed for ${displayHost}. ${detail}`
}

/** Typed denial must stop credential prompts before any secret is offered to a possibly impersonated host. */
export class HostKeyVerificationError extends Error {
  readonly outcome: KnownHostsOutcome

  constructor(message: string, outcome: KnownHostsOutcome) {
    super(message)
    this.name = 'HostKeyVerificationError'
    this.outcome = outcome
  }
}

export function isHostKeyVerificationError(err: unknown): err is HostKeyVerificationError {
  return err instanceof HostKeyVerificationError
}

export function decideHostKey(input: HostKeyDecisionInput): HostKeyDecision {
  const {
    knownHostsOutcome,
    storeOutcome,
    policy,
    siteConfigSuppressed,
    knownHostsUnreadable,
    displayHost,
    port,
    hostKeyStoreFile
  } = input
  const strict = input.strictHostKeyChecking.toLowerCase()

  // Revoked keys are known bad, overriding even lax checking.
  if (knownHostsOutcome === 'revoked') {
    return {
      action: 'reject',
      outcome: 'revoked',
      disagreeingSource: 'known-hosts',
      reason: rejection(displayHost, 'This host key has been revoked.')
    }
  }

  // Prefer known_hosts mismatch guidance because its remedy also unblocks SSH/git.
  if (knownHostsOutcome === 'mismatch') {
    return {
      action: 'reject',
      outcome: 'mismatch',
      disagreeingSource: 'known-hosts',
      reason: rejection(
        displayHost,
        `The key does not match the entry in your known_hosts file. ssh and git will refuse this host too. Run: ssh-keygen -R ${keygenRemoveTarget(displayHost, port)}`
      )
    }
  }
  // Accept known_hosts after legitimate rotation even if Orca trust is stale; it is the authority OpenSSH obeys.
  if (knownHostsOutcome === 'match') {
    return { action: 'accept', outcome: 'match' }
  }
  if (storeOutcome === 'mismatch') {
    return {
      action: 'reject',
      outcome: 'mismatch',
      disagreeingSource: 'orca-store',
      reason: rejection(
        displayHost,
        `The key changed since you last connected. ${changedKeyHint(hostKeyStoreFile)}`
      )
    }
  }

  if (storeOutcome === 'match') {
    return { action: 'accept', outcome: 'match' }
  }

  // Switching key type on a known host is a downgrade attempt, never fresh first contact.
  if (
    knownHostsOutcome === 'unknown-type-known-host' ||
    storeOutcome === 'unknown-type-known-host'
  ) {
    const fromKnownHosts = knownHostsOutcome === 'unknown-type-known-host'
    return {
      action: 'reject',
      outcome: 'unknown-type-known-host',
      disagreeingSource: fromKnownHosts ? 'known-hosts' : 'orca-store',
      reason: rejection(
        displayHost,
        // OpenSSH also refuses known hosts offering a different key type; ssh-keygen -R unblocks both.
        `The host offered a key of a type we have not seen for it before, while a key of another type is already known. This can mean the host was rebuilt, or that something is impersonating it.${
          fromKnownHosts
            ? ` ssh and git will refuse this host too. Run: ssh-keygen -R ${keygenRemoveTarget(displayHost, port)}`
            : ` ${changedKeyHint(hostKeyStoreFile)}`
        }`
      )
    }
  }

  // Preserve CA-only evidence for audit despite its first-contact action.
  const unknownOutcome: KnownHostsOutcome = knownHostsOutcome === 'ca-only' ? 'ca-only' : 'unknown'

  // ssh2 cannot verify CA certificates; product policy accepts CA-only plain keys as OpenSSH first contact, retaining that unverifiable-CA outcome.
  if (STRICT_VALUES.has(strict)) {
    return {
      action: 'reject',
      outcome: unknownOutcome,
      reason: rejection(
        displayHost,
        'The host is not listed in your known_hosts file and StrictHostKeyChecking is enabled.'
      )
    }
  }
  // Ephemeral VMs cannot have prior trust; accept without recording after explicit strict policy but before incomplete site-config evidence.
  if (policy.kind === 'ephemeral') {
    return { action: 'accept', outcome: unknownOutcome }
  }
  if (siteConfigSuppressed) {
    // Unreadable site policy cannot authorize extending new durable-host trust.
    return {
      action: 'reject',
      outcome: unknownOutcome,
      reason: rejection(
        displayHost,
        'The host is unknown and the system SSH configuration could not be read, so its host key policy cannot be checked.'
      )
    }
  }
  if (knownHostsUnreadable) {
    // Connect like ssh but never persist unreadable trust evidence.
    return { action: 'accept', outcome: unknownOutcome }
  }
  if (LAX_VALUES.has(strict)) {
    // Lax OpenSSH policy accepts without writing; preserve that choice.
    return { action: 'accept', outcome: unknownOutcome }
  }
  return { action: 'accept-and-remember', outcome: unknownOutcome }
}
