/**
 * What to do about a presented host key.
 *
 * Kept separate from the ssh2 wiring so the policy is testable without a handshake, and injected
 * rather than importing its sources so a test states its own trust state instead of writing files.
 * See docs/reference/ssh-host-key-verification.md.
 */
import type { KnownHostsOutcome } from './ssh-known-hosts'

/** Phase 1 ships no dialog; `prompt` is reserved for Phase 2 and never produced today. */
export type HostKeyAction = 'accept' | 'accept-and-remember' | 'reject' | 'prompt'

export type HostKeyDecision = {
  action: HostKeyAction
  outcome: KnownHostsOutcome
  /** Which source disagreed, so the failure message can point at a remedy that exists. */
  disagreeingSource?: 'orca-store' | 'known-hosts'
  /** Non-null only when the connection must fail; already user-facing. */
  reason?: string
}

export type HostKeyDecisionInput = {
  /** From the user's known_hosts files, unioned. */
  knownHostsOutcome: KnownHostsOutcome
  /** From our own store: does it already hold this exact key for host+port+type? */
  storeOutcome: 'match' | 'mismatch' | 'unknown-type-known-host' | 'unknown'
  /** Effective `StrictHostKeyChecking`; anything unrecognised is treated as `ask`. */
  strictHostKeyChecking: string
  /**
   * A freshly provisioned VM presents a new key every launch, so first contact is expected rather
   * than suspicious — and persisting would accumulate a record per launch.
   */
  isEphemeralRuntimeTarget: boolean
  /**
   * `ssh -G` ran on the HOME-divergent `-F` path, which suppresses /etc/ssh/ssh_config, so a
   * site-wide StrictHostKeyChecking may exist that we cannot see. We refuse a NEW host rather than
   * risk being laxer than the policy; a host we already know still connects, because a match is
   * decided before this is consulted.
   */
  siteConfigSuppressed: boolean
  /**
   * A known_hosts file exists and would not open — a Windows OneDrive placeholder while offline,
   * EACCES on a hardened image, an NFS blip. The entry that would have said "this key changed" may
   * be in it.
   *
   * Deliberately NOT a refusal: ssh warns and treats the host as unknown, and refusing here breaks
   * an ordinary offline corporate laptop while blaming a config file that is fine. We connect as ssh
   * does but record nothing, so a first contact we could not check never becomes durable trust.
   */
  knownHostsUnreadable: boolean
  displayHost: string
  /** Needed for the remedy string: an off-port entry is keyed `[host]:port` in known_hosts. */
  port: number
  /**
   * Our own store's path, named in a changed-key rejection.
   *
   * Only that rejection needs it, and only because known_hosts cannot cure it: a host we trusted on
   * first contact and never wrote to known_hosts has no `ssh-keygen -R` to run, so without naming a
   * file the message describes a remedy the user cannot locate.
   */
  hostKeyStoreFile?: string
}

/**
 * The name `ssh-keygen -R` must be given, which is NOT always the host name.
 *
 * Verified against OpenSSH 10.2p1: with both `[h.example]:2222` and `h.example` on file,
 * `ssh-keygen -R h.example` removes only the bare line and leaves the bracketed one — and there is
 * no port flag, `-R host -p 2222` is "Too many arguments". So for an off-port target the obvious
 * command removes nothing, the user reconnects, and it fails identically.
 */
function keygenRemoveTarget(displayHost: string, port: number): string {
  return port === 22 ? displayHost : `'[${displayHost}]:${port}'`
}

/**
 * `true` and `false` are not defensive extras — they are the ONLY spellings that reach us.
 *
 * `ssh -G` renders StrictHostKeyChecking through fmt_multistate_int, which prints the first entry of
 * multistate_strict_hostkey, and that table lists true/false before yes/no. Verified against
 * OpenSSH 10.2p1 from both a config file and `-o`: `yes` prints `true`, `no` and `off` both print
 * `false`, while `ask` and `accept-new` pass through unchanged. Matching only yes/no/off therefore
 * matched nothing a real config can produce — `StrictHostKeyChecking yes` fell through to the
 * default and we accepted AND persisted a host the user had told ssh to refuse.
 */
const STRICT_VALUES = new Set(['true', 'yes', 'always'])
const LAX_VALUES = new Set(['false', 'no', 'off'])

/**
 * The stricter of a user-resolved and a site-resolved StrictHostKeyChecking.
 *
 * Needed only where the two were read separately: `ssh -F` makes OpenSSH ignore /etc/ssh/ssh_config,
 * so the per-user resolution cannot represent a site policy and the site has to be probed on its
 * own. Ordering is strict > accept-new > ask > lax, and anything unrecognised is left to the
 * caller's own handling by falling through to the user value.
 */
export function strictestHostKeyChecking(
  userValue: string | undefined,
  siteValue: string | null
): string {
  const user = userValue ?? 'ask'
  if (siteValue === null) {
    return user
  }
  const site = siteValue.trim().toLowerCase()
  if (STRICT_VALUES.has(site) && !STRICT_VALUES.has(user.trim().toLowerCase())) {
    return site
  }
  // A site that is lax never loosens a user who is not: refusing to write trust is the safe side.
  return LAX_VALUES.has(site) ? user : site === 'accept-new' && user === 'ask' ? site : user
}

const CHANGED_KEY_HINT =
  'If you rebuilt or reprovisioned this machine, remove the saved key and reconnect.'

/**
 * The same hint, naming the file when we know it.
 *
 * "Remove the saved key" names nothing a user can find. This rejection is reachable for a host we
 * trusted on first contact and that has since rotated its key legitimately — known_hosts cannot
 * rescue that one, so without a concrete path there is no way out of it at all.
 */
function changedKeyHint(hostKeyStoreFile: string | undefined): string {
  return hostKeyStoreFile
    ? `If you rebuilt or reprovisioned this machine, remove its entry from ${hostKeyStoreFile} and reconnect.`
    : CHANGED_KEY_HINT
}

/**
 * Deliberately avoids the words "authentication failed" and "permission denied": the reconnect
 * ladder classifies on those substrings, and a denial that reads as an auth error gets retried
 * forever against a decision that will never change.
 */
function rejection(displayHost: string, detail: string): string {
  return `Host key verification failed for ${displayHost}. ${detail}`
}

/**
 * A denied host key, carried as a type rather than sniffed from the message.
 *
 * The connect path must recognise this before it offers any credential: prompting for a passphrase
 * or a password after we have decided the host may be impersonated is the one thing a host key check
 * exists to prevent — the user types the secret straight into whatever answered. Substring matching
 * would tie that to wording that the reason strings deliberately keep changing.
 */
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
    isEphemeralRuntimeTarget,
    siteConfigSuppressed,
    knownHostsUnreadable,
    displayHost,
    port,
    hostKeyStoreFile
  } = input
  const strict = input.strictHostKeyChecking.toLowerCase()

  // Revocation outranks everything, including StrictHostKeyChecking=no. A revoked key is a
  // statement that this key is known-bad, not merely unrecognised.
  if (knownHostsOutcome === 'revoked') {
    return {
      action: 'reject',
      outcome: 'revoked',
      disagreeingSource: 'known-hosts',
      reason: rejection(displayHost, 'This host key has been revoked.')
    }
  }

  // Either source holding a different key for this host and type is a change. known_hosts is named
  // first because its remedy (ssh-keygen -R) is the one that also unblocks ssh and git.
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
  // Why known_hosts outranks our own record here: this is what a legitimate key rotation looks like
  // once the user has run the remedy we print. `ssh-keygen -R host` then a reconnect leaves
  // known_hosts holding the NEW key while our store still holds the old one, and checking the store
  // first refused exactly the state that cure produces — permanently, since nothing in the app
  // clears the store. Deferring to known_hosts concedes nothing: it is the artefact ssh itself
  // obeys, so an attacker who can rewrite it has already won.
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

  // We hold a key for this host, just not of the presented type. Treating that as first contact is
  // the downgrade an attacker who cannot forge the known key would reach for.
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
        // Verified live against OpenSSH 10.2p1: an ed25519 key offered where known_hosts holds only
        // ssh-rsa makes ssh print IDENTIFICATION HAS CHANGED and refuse. So ssh is blocked too, and
        // ssh-keygen -R is the remedy that unblocks both — naming it only for the same-type
        // mismatch left this case with a diagnosis and no way out.
        `The host offered a key of a type we have not seen for it before, while a key of another type is already known. This can mean the host was rebuilt, or that something is impersonating it.${
          fromKnownHosts
            ? ` ssh and git will refuse this host too. Run: ssh-keygen -R ${keygenRemoveTarget(displayHost, port)}`
            : ` ${changedKeyHint(hostKeyStoreFile)}`
        }`
      )
    }
  }

  // `ca-only` is carried through so the decision log still shows a CA line was involved, even
  // though the action is the same as first contact.
  const unknownOutcome: KnownHostsOutcome = knownHostsOutcome === 'ca-only' ? 'ca-only' : 'unknown'

  // Unknown from here down — including `ca-only`, by decision. ssh2 cannot validate certificates at
  // all, and OpenSSH itself treats a CA-covered host that presents a plain key as first contact and
  // connects (verified live). Refusing was stricter than ssh and, because `@cert-authority *` is the
  // normal Teleport/Vault-SSH/Smallstep shape, it failed EVERY target for those users — with an
  // escape hatch that is an environment variable, unreachable when Orca is launched from the Dock.
  // The residual risk is real and accepted: for a CA-protected host we accept a plain key we cannot
  // tie to the CA. The outcome is preserved so the decision is still auditable.
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
  // Deliberately ABOVE the incomplete-sources check, and deliberately BELOW explicit strict.
  //
  // A machine provisioned a minute ago cannot be in known_hosts, by construction — no policy, seen
  // or unseen, can be satisfied by it. So refusing here would not make the connection safer, it
  // would turn on-demand runtimes off entirely for anyone whose HOME diverges from their passwd
  // home (sandboxes, E2E isolation), and the reason we would print names a config file they cannot
  // fix. Incomplete sources is a statement that we might be missing a policy; it is not a policy.
  // An EXPLICIT StrictHostKeyChecking=yes still wins above, because that one we can actually read
  // and the user asked for it.
  //
  // Accepting without recording is the rest of it: a new key every launch would otherwise grow a
  // row per VM, and a stale row eventually reads as a mismatch against a host that did nothing
  // wrong.
  if (isEphemeralRuntimeTarget) {
    return { action: 'accept', outcome: unknownOutcome }
  }
  if (siteConfigSuppressed) {
    // We could not read the system ssh_config, so we cannot prove a site policy does not forbid
    // this. Refusing to extend NEW trust while blind is the only way to avoid being laxer than ssh.
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
    // Connect as ssh does, but do not write a record from evidence we could not read.
    return { action: 'accept', outcome: unknownOutcome }
  }
  if (LAX_VALUES.has(strict)) {
    // OpenSSH accepts here but does not write. Persisting would silently convert a deliberately
    // lax setting into a permanent trust record.
    return { action: 'accept', outcome: unknownOutcome }
  }
  return { action: 'accept-and-remember', outcome: unknownOutcome }
}
