import {
  createManagedCommandMatcher,
  readHooksJsonWithRaw,
  type HookDefinition,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import {
  assertHooksJsonGeneration,
  backupRealHomeHooksJsonOnce,
  getRealHomeHookKeySourcePaths,
  HooksJsonChangedError,
  isAddableHooksFile
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import {
  CODEX_EVENT_LABEL,
  type CodexManagedHookInstallMaterial,
  getCodexManagedHookInstallMaterial,
  getSystemCodexConfigTomlPath
} from './codex-hook-definition'
import {
  findStopgapOrcaHashes,
  getRealHomeCodexHookHome,
  isKnownOrcaHash,
  readKnownOrcaHashes
} from './codex-hook-orca-approvals'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-moves'
import { sweepRealHomeCodexHook } from './codex-real-home-hook-sweep'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import {
  planRealHomeCodexHookEntries,
  type RealHomeCodexHookEntryPlan
} from './codex-real-home-hook-entry-plan'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import {
  findMissingCodexHookApprovals,
  writeCodexHookApprovalsBeforeEntries
} from './codex-hook-approval-first-write'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexHookTrustState
} from './config-toml-trust'

type ReconcileArgs = {
  /** Codex's hashes; null while Codex has not answered, when Orca keeps or computes its own. */
  hashes: CodexHookHashes | null
  isEnabled: () => boolean
  /** App start and the setting turning on; a launch never fights a running older build. */
  convertOlderForms: boolean
}

type SettlePlan = Extract<RealHomeCodexHookEntryPlan, { kind: 'settle' }>

// Why a bound: each pass either prunes Orca's extra copies or settles; a concurrent save costs one more.
const MAX_PASSES = 4

/**
 * Makes ~/.codex hold Orca's entry alone, last unless already in place, in each
 * event Codex lists, with Codex's hash for it approved and enabled. Writes only
 * what differs; an approval goes in before its entry and is taken back if the
 * entry write fails. Never throws.
 */
export async function reconcileRealHomeCodexHookEntries(args: ReconcileArgs): Promise<void> {
  try {
    await runExclusivelyForCodexTrustConfig(getSystemCodexConfigTomlPath(), async () => {
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        if (!args.isEnabled()) {
          return
        }
        try {
          if (reconcilePass(args) === 'settled') {
            return
          }
        } catch (error) {
          // Why: a user's save landed between Orca's read and write; the next pass reads it.
          if (!(error instanceof HooksJsonChangedError)) {
            throw error
          }
        }
      }
      throw new Error('Orca entries in ~/.codex did not settle')
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not reconcile Orca entries in ~/.codex:', error)
  }
}

/** 'pruned' when another pass must settle what this one left; else 'settled', even when ~/.codex cannot take the entry. */
function reconcilePass(args: ReconcileArgs): 'settled' | 'pruned' {
  const home = getRealHomeCodexHookHome()
  const { hooksJsonPath, tomlPath, keySourcePaths: sourcePaths } = home
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Why: the pre-write guard compares against these bytes; a separate later
  // read would let a concurrent save land between parse and write.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!isAddableHooksFile(config)) {
    return 'settled'
  }
  const hooks = config.hooks ?? {}
  const material = getCodexManagedHookInstallMaterial()
  // Why only listed events: an entry Codex has no hash for would wait for review.
  const listed = args.hashes
  const events = listed
    ? material.events.filter((eventName) => listed[CODEX_EVENT_LABEL[eventName]] !== undefined)
    : material.events
  const plan = planRealHomeCodexHookEntries({
    hooks,
    sourcePath: sourcePaths[0],
    material: { events, command: material.command },
    isOrcaCommand: createManagedCommandMatcher(getCodexManagedScriptFileName()),
    convertOlderForms: args.convertOlderForms
  })
  const writeHooks = (nextHooks: Record<string, HookDefinition[]>): void => {
    backupRealHomeHooksJsonOnce(getOrcaUserDataPath(), previousRaw)
    assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
    // Why: unknown fields inside the file belong to the user; preserve them verbatim.
    writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
  }
  if (plan.kind === 'prune') {
    // Why its own write: dropping a copy shifts user hooks, whose approvals must move
    // before Orca writes an approval at a slot one of them still holds.
    mutateRealHomeHooksPreservingUserTrust({
      sourcePaths,
      tomlPath,
      beforeHooks: hooks,
      afterHooks: plan.hooks,
      writeHooks: () => writeHooks(plan.hooks)
    })
    return 'pruned'
  }

  const trustStates = readHookTrustEntries(tomlPath)
  const knownOrcaHashes = readKnownOrcaHashes(home, material.command)
  // Why the stopgap: an entry already in place keeps its approval, so nothing changes.
  const hashes =
    args.hashes ??
    findStopgapOrcaHashes({
      trustStates,
      hooks,
      keySourcePaths: sourcePaths,
      command: material.command,
      knownOrcaHashes
    })
  const approvals = sourcePaths.flatMap((keySource) =>
    plan.managedEntries.flatMap((entry) => {
      const trustedHash = hashes[entry.eventLabel]
      // Why none for null: that Codex lists the entry with no hash, so it runs unapproved.
      return typeof trustedHash === 'string'
        ? [{ ...entry, sourcePath: keySource, trustedHash, enabled: true }]
        : []
    })
  )
  const findStale = (states: ReadonlyMap<string, CodexHookTrustState>): string[] =>
    findStaleOrcaApprovals(states, events, sourcePaths, knownOrcaHashes, plan)
  const changed = plan.changedLabels.size > 0
  if (
    !changed &&
    findMissingCodexHookApprovals(approvals, tomlPath).length === 0 &&
    findStale(trustStates).length === 0
  ) {
    return 'settled'
  }

  writeManagedScript(material.scriptPath, material.script)
  writeCodexHookApprovalsBeforeEntries(
    tomlPath,
    approvals,
    () => {
      if (changed) {
        writeHooks(plan.hooks)
      }
    },
    hooksJsonPath
  )
  try {
    // Why read again: approvals Orca just wrote, or a user's moved one, may sit at a key read stale before.
    removeHookTrustEntries(tomlPath, findStale(readHookTrustEntries(tomlPath)))
  } catch (error) {
    // Why still written: the entry and its approval are in place; a leftover approval matches no hook.
    console.warn('[codex-real-home-hooks] could not drop stale Orca approvals:', error)
  }
  return 'settled'
}

/**
 * Approvals Orca left at a slot its entry no longer holds, such as a copy it
 * removed from a user's group. Owned only while they hold a hash Orca writes.
 * Never at a slot Orca's entry holds, whatever its hash, nor in an event this
 * run did not plan or left alone: its entries keep theirs.
 */
function findStaleOrcaApprovals(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  events: CodexManagedHookInstallMaterial['events'],
  sourcePaths: readonly string[],
  knownOrcaHashes: readonly CodexHookHashes[],
  plan: SettlePlan
): string[] {
  const plannedLabels = new Set(events.map((eventName) => CODEX_EVENT_LABEL[eventName]))
  const held = new Set(
    sourcePaths.flatMap((sourcePath) =>
      plan.managedEntries.map((entry) =>
        normalizeHookTrustKeyForLookup(computeTrustKey({ ...entry, sourcePath }))
      )
    )
  )
  return [...trustStates].flatMap(([key, state]) => {
    const parts = parseTrustKey(key)
    return parts &&
      plannedLabels.has(parts.eventLabel) &&
      !plan.untouchedLabels.has(parts.eventLabel) &&
      !held.has(normalizeHookTrustKeyForLookup(key)) &&
      sourcePaths.some((sourcePath) => codexHookSourcePathsEqual(parts.sourcePath, sourcePath)) &&
      isKnownOrcaHash(knownOrcaHashes, parts.eventLabel, state.trustedHash)
      ? [key]
      : []
  })
}

/**
 * The user's explicit opt-out: strips Orca's entry and its approvals from the
 * real ~/.codex, moving the approvals of user hooks whose positions shift.
 * Never throws.
 */
export async function removeRealHomeCodexHookForOptOut(
  codexHashes: readonly CodexHookHashes[]
): Promise<'removed' | 'unavailable'> {
  try {
    return await runExclusivelyForCodexTrustConfig(getSystemCodexConfigTomlPath(), async () => {
      const lane = sweepRealHomeCodexHook()
      // Why 'removed' only: an unread or malformed file may still hold the entry,
      // so its approvals and the ledger that proves ownership wait for a later pass.
      if (lane === 'removed') {
        // Why: Codex's own hashes prove Orca's approvals, including ones a sweep with no entry left to remove skips.
        removeSystemManagedHookTrustEntries(
          getSystemCodexHomePath(),
          getRealHomeHookKeySourcePaths(),
          codexHashes
        )
      }
      return lane
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] opt-out cleanup failed:', error)
    return 'unavailable'
  }
}
