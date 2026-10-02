import {
  createManagedCommandMatcher,
  readHooksJsonWithRaw,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import {
  assertHooksJsonGeneration,
  backupRealHomeHooksJsonOnce,
  getRealHomeConfigTomlPath,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import {
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS,
  findCurrentManagedCodexHookTrust,
  type CodexManagedTrustGrantOutcome,
  type CodexManagedTrustGrantPlan
} from './codex-hook-trust-grant'
import { readCodexTrustGrantLedgerHomeForReconciliation } from './codex-managed-trust-reconciliation'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { getSystemCodexHomePath } from './codex-home-paths'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-moves'
import { sweepRealHomeCodexHook } from './codex-real-home-hook-sweep'
import {
  runExclusivelyForCodexTrustConfig,
  runOutsideCodexTrustConfigLanes
} from './codex-trust-config-mutation-queue'
import {
  planRealHomeCodexHookEntries,
  type RealHomeCodexHookSlotWrite,
  type RealHomeCodexHookWritePolicy
} from './codex-real-home-hook-entry-plan'
import {
  _internals as approvalInternals,
  describeRealHomeApprovalRetry,
  hasUnapprovedRealHomeOrcaEntry,
  recordRealHomeApprovalOutcome,
  requestRealHomeCodexApproval,
  type RealHomeBackgroundGrant
} from './codex-real-home-background-grant'
import { withdrawUntrustedRealHomeWrites } from './codex-real-home-hook-withdrawal'

export type { RealHomeCodexHookWritePolicy }

/**
 * What the real-home check last concluded, for the routing gate (flag ON,
 * system default). Output only: no decision in this module reads it.
 *
 * - 'pending': no attempt yet this process; routing may optimistically use the
 *   real home (reads are hook-free and the install runs before pane spawns).
 * - 'approving': the entry is written, and Codex's approval runs in the
 *   background. Launches use the managed home until it lands; a resume waits.
 * - 'installed': every managed event in ~/.codex/hooks.json has an Orca entry,
 *   and the frozen ones are trusted by codex itself through the app-server grant.
 * - 'unavailable': the grant lane could not trust the entry (old binary,
 *   unsupported RPC, verify failure), or its retry window is still open. An
 *   entry the attempt wrote that is still untrusted is withdrawn.
 * - 'removed': hooks are off here. Launch prep leaves the real home as it is;
 *   only an explicit opt-out strips Orca's entry, since other Orcas share it.
 */
export type RealHomeCodexHookVerdict =
  | 'pending'
  | 'approving'
  | 'installed'
  | 'unavailable'
  | 'removed'

type RealHomeCodexHookIntent = {
  hooksEnabled: boolean
  userDataPath: string
  writePolicy: RealHomeCodexHookWritePolicy
}

type Approval = {
  /** What this attempt wrote; only its own settle withdraws it. */
  writes: readonly RealHomeCodexHookSlotWrite[]
  command: string
  /** Settles once Codex approved, or this attempt's unapproved adds are withdrawn. */
  done: Promise<void>
}

let verdict: RealHomeCodexHookVerdict = 'pending'
// Why: at most one Codex approval session per process.
let approval: Approval | null = null
let installRetryAfterMs = 0
let readCodexHooksEnabled: () => boolean = () => true

export function getRealHomeCodexHookVerdict(): RealHomeCodexHookVerdict {
  return verdict
}

/** The settings' answer, read when an approval settles after its caller has gone. */
export function setRealHomeCodexHooksEnabledReader(read: () => boolean): void {
  readCodexHooksEnabled = read
}

/**
 * Routing gate consumed by CodexRuntimeHomeService. Never usable while an
 * approval runs, whatever the verdict says. Both a failed install and a failed
 * opt-out cleanup use the managed lane so no half-mutated hook state can
 * diverge from PTY, rate-limit, or commit-message routing.
 */
export function isRealHomeCodexHookLaneUsable(): boolean {
  return approval === null && verdict !== 'unavailable' && verdict !== 'approving'
}

/**
 * Installs and trusts the Orca status hook in the real home when hooks are on,
 * and writes nothing when they are off. Add-only: it never removes an Orca
 * entry, and only `convert-older-forms` rewrites one. Idempotent; a home that
 * already holds the frozen entry costs one read, and a valid grant ledger skips
 * the RPC session. Never waits on a session: Codex's approval runs in the
 * background. Never throws: any failure logs and leaves the managed lane.
 */
export async function ensureRealHomeCodexHookState(
  intent: RealHomeCodexHookIntent
): Promise<RealHomeCodexHookVerdict> {
  try {
    // Why one lane-held step: finding no approval running and starting one are
    // atomic, and the lane also orders this write against the retired-form sweep.
    return await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), () =>
      reconcileRealHomeCodexHook(intent)
    )
  } catch (error) {
    return failRealHomeCodexHookCheck(error)
  }
}

/**
 * For a resume that must run in the real home, with no managed home to fall
 * back to: while an approval runs and Codex would put an Orca entry up for
 * review, waits for that one approval, which its session's 30 s limit bounds.
 */
export async function awaitRealHomeCodexHookTrust(): Promise<void> {
  const current = approval
  if (current && hasUnapprovedRealHomeOrcaEntry(current.command)) {
    await current.done
  }
}

async function reconcileRealHomeCodexHook(
  intent: RealHomeCodexHookIntent
): Promise<RealHomeCodexHookVerdict> {
  if (approval) {
    // Why: a launch never waits on Codex's approval, and the running one covers
    // add-missing. App start's conversion is the process's first check, so none waits here.
    return (verdict = 'approving')
  }
  if (!intent.hooksEnabled) {
    // Why: this runs for launch prep and startup, and the entry is shared by
    // every Orca on this HOME; removing it is the explicit opt-out's job.
    installRetryAfterMs = 0
    return (verdict = 'removed')
  }
  if (Date.now() < installRetryAfterMs) {
    // Why: writing and withdrawing the entry again before then only adds work to every launch.
    return (verdict = 'unavailable')
  }
  const install = await installRealHomeCodexHook(intent.userDataPath, intent.writePolicy)
  if (!install.grant) {
    if (install.verdict === 'installed') {
      installRetryAfterMs = 0
    }
    return (verdict = install.verdict)
  }
  approval = startApproval(install.grant)
  return (verdict = 'approving')
}

function failRealHomeCodexHookCheck(error: unknown): RealHomeCodexHookVerdict {
  console.warn('[codex-real-home-hooks] ensure failed; staying on managed lane:', error)
  installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
  return (verdict = 'unavailable')
}

function startApproval(grant: RealHomeBackgroundGrant): Approval {
  const adds = { writes: grant.writes, command: grant.command }
  // Why outside the lane: the session holds none, and its settle queues for it like any writer.
  const done = runOutsideCodexTrustConfigLanes(async () => {
    const outcome = await requestRealHomeCodexApproval(grant.plan)
    try {
      await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), () =>
        settleApproval(adds, outcome)
      )
    } catch (error) {
      // Why: a settle that cannot run must still end its own flight, or every check answers 'approving'.
      if (approval?.done === done) {
        approval = null
      }
      failRealHomeCodexHookCheck(error)
    }
  })
  return { ...adds, done }
}

async function settleApproval(
  adds: Omit<Approval, 'done'>,
  outcome: CodexManagedTrustGrantOutcome | null
): Promise<void> {
  const approved = outcome?.lane === 'rpc'
  let withdrawn = 0
  if (!approved) {
    // Why: an untrusted Orca entry surfaces as "Hooks need review". Withdraw only
    // what this attempt wrote, and only while it is still untrusted: another
    // Orca may have trusted the identical entry meanwhile.
    try {
      withdrawn = withdrawUntrustedRealHomeWrites(adds.writes, adds.command)
    } catch (error) {
      console.warn('[codex-real-home-hooks] background trust grant failed:', error)
    }
  }
  installRetryAfterMs = recordRealHomeApprovalOutcome(outcome)
  approval = null
  // Why from the settings: hooks turned off during the session must not read as
  // installed, and an opt-out that failed meanwhile may have left the entry.
  if (readCodexHooksEnabled()) {
    verdict = approved ? 'installed' : 'unavailable'
  } else if (verdict !== 'unavailable') {
    verdict = 'removed'
  }
  if (outcome?.lane !== 'rpc') {
    console.warn(
      `[codex-real-home-hooks] Codex did not approve Orca's entry (${outcome?.reason ?? 'error'}); ` +
        `withdrew ${withdrawn} unapproved entr${withdrawn === 1 ? 'y' : 'ies'} this attempt added; ` +
        `managed lane kept, ${describeRealHomeApprovalRetry(installRetryAfterMs)}`
    )
  }
}

async function installRealHomeCodexHook(
  userDataPath: string,
  writePolicy: RealHomeCodexHookWritePolicy
): Promise<{ verdict: RealHomeCodexHookVerdict; grant?: RealHomeBackgroundGrant }> {
  const material = getCodexManagedHookInstallMaterial()
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Why: the pre-write guard compares against these bytes; a separate later
  // read would let a concurrent save land between parse and write.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config) {
    // Why: an unparseable user file must never be clobbered; without a hook
    // entry the managed lane keeps status working for this host.
    console.warn('[codex-real-home-hooks] could not parse', hooksJsonPath, '- managed lane kept')
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return { verdict: 'unavailable' }
  }
  if (Object.keys(config).some((key) => key !== 'hooks')) {
    // Why: Codex rejects unknown root keys instead of ignoring them. Avoid a
    // transient rewrite of a user-owned file that the trust RPC cannot load.
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return { verdict: 'unavailable' }
  }

  // Why: the same script the managed lane maintains; deploying here too keeps
  // host-connect ordering independent of the managed installer loop.
  writeManagedScript(material.scriptPath, material.script)

  const plan = planRealHomeCodexHookEntries({
    hooks: config.hooks ?? {},
    sourcePath: hooksJsonPath,
    material,
    isOrcaCommand: createManagedCommandMatcher(getCodexManagedScriptFileName()),
    policy: writePolicy
  })
  if (plan.changed) {
    backupRealHomeHooksJsonOnce(userDataPath, previousRaw)
    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: hooksJsonPath,
      tomlPath: getRealHomeConfigTomlPath(),
      beforeHooks: config.hooks ?? {},
      afterHooks: plan.hooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        // Why: unknown top-level fields belong to the user (other managers'
        // metadata); unlike the managed-home writer, preserve them verbatim.
        writeHooksJson(hooksWritePath, { ...config, hooks: plan.hooks }, { preserveMode: true })
      }
    })
  }
  if (plan.managedEntries.length === 0) {
    // Why: every event holds an entry of another form, which its writer keeps trusted.
    return { verdict: 'installed' }
  }

  const grantPlan: CodexManagedTrustGrantPlan = {
    runtimeHomePath: getSystemCodexHomePath(),
    tomlPath: getRealHomeConfigTomlPath(),
    managedCommand: material.command,
    managedEntries: plan.managedEntries,
    host: { kind: 'native' },
    telemetryLane: 'real-home',
    useDefaultCodexHome: true,
    background: true
  }
  if (await findCurrentManagedCodexHookTrust(grantPlan)) {
    return { verdict: 'installed' }
  }
  return {
    verdict: 'approving',
    grant: { plan: grantPlan, writes: plan.writes, command: material.command }
  }
}

/**
 * The user's explicit opt-out: strips Orca's entry and its trust from the real
 * ~/.codex. Joins the system lane an opt-out caller already holds.
 */
export async function removeRealHomeCodexHookForOptOut(): Promise<RealHomeCodexHookVerdict> {
  try {
    const lane = await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), async () => {
      const lane = await sweepRealHomeCodexHook()
      const systemHomePath = getSystemCodexHomePath()
      // Why 'removed' only: an unread or malformed file may still hold the entry,
      // so its trust and the ledger that proves ownership must wait for a later pass.
      if (
        lane === 'removed' &&
        readCodexTrustGrantLedgerHomeForReconciliation(systemHomePath) !== null
      ) {
        // Why: the ledger outlives a sweep that removed the entry but not its trust.
        removeSystemManagedHookTrustEntries(systemHomePath, getRealHomeHooksJsonPath())
      }
      return lane
    })
    verdict = lane
  } catch (error) {
    console.warn('[codex-real-home-hooks] opt-out cleanup failed; staying on managed lane:', error)
    verdict = 'unavailable'
  }
  return verdict
}

export const _internals = {
  resetForTesting(state: RealHomeCodexHookVerdict): void {
    verdict = state
    approval = null
    installRetryAfterMs = 0
    readCodexHooksEnabled = () => true
    approvalInternals.resetTimeoutStreakForTesting()
  },
  /** The verdict once every queued check and any approval it started have settled. */
  async settledVerdictForTesting(): Promise<RealHomeCodexHookVerdict> {
    await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), async () => {})
    while (approval) {
      await approval.done
    }
    return verdict
  }
}
