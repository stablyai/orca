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
  HooksJsonChangedError,
  isAddableHooksFile
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import {
  CODEX_EVENT_LABEL,
  type CodexManagedHookInstallMaterial,
  getCodexManagedHookInstallMaterial
} from './codex-hook-definition'
import {
  type CodexHookHome,
  findStopgapOrcaHashes,
  getRealHomeCodexHookHome,
  isKnownOrcaHash,
  readKnownOrcaHashes
} from './codex-hook-orca-approvals'
import { getOrcaUserDataPath } from './codex-home-paths'
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
  /** Null uses existing or locally computed hashes until Codex answers. */
  hashes: CodexHookHashes | null
  isEnabled: () => boolean
  /** Convert older forms at startup/opt-in, never on launch. */
  convertOlderForms: boolean
}

type SettlePlan = Extract<RealHomeCodexHookEntryPlan, { kind: 'settle' }>

// Allow pruning, settlement and concurrent-save retries without looping indefinitely.
const MAX_PASSES = 4

/** Approve before writing entries; roll back approvals if the entry write fails. */
export async function reconcileRealHomeCodexHookEntries(args: ReconcileArgs): Promise<void> {
  await reconcileCodexHookEntriesInHome(getRealHomeCodexHookHome(), args, { pristineBackup: true })
}

export async function reconcileCodexHookEntriesInHome(
  home: CodexHookHome,
  args: ReconcileArgs,
  options: { pristineBackup: boolean } = { pristineBackup: false }
): Promise<void> {
  try {
    await runExclusivelyForCodexTrustConfig(home.tomlPath, async () => {
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        if (!args.isEnabled()) {
          return
        }
        try {
          if (reconcilePass(home, args, options.pristineBackup) === 'settled') {
            return
          }
        } catch (error) {
          // Retry from the user's latest save.
          if (!(error instanceof HooksJsonChangedError)) {
            throw error
          }
        }
      }
      throw new Error(`Orca entries in ${home.homePath} did not settle`)
    })
  } catch (error) {
    console.warn(
      `[codex-real-home-hooks] could not reconcile Orca entries in ${home.homePath}:`,
      error
    )
  }
}

// Settlement also covers homes that cannot accept Orca's entry.
function reconcilePass(
  home: CodexHookHome,
  args: ReconcileArgs,
  pristineBackup: boolean
): 'settled' | 'pruned' {
  const { hooksJsonPath, tomlPath, keySourcePaths: sourcePaths } = home
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Guard the exact bytes parsed so a concurrent save cannot be overwritten.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!isAddableHooksFile(config)) {
    return 'settled'
  }
  const hooks = config.hooks ?? {}
  const material = getCodexManagedHookInstallMaterial()
  // Unlisted events lack a Codex hash and would wait for review.
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
    if (pristineBackup) {
      backupRealHomeHooksJsonOnce(getOrcaUserDataPath(), previousRaw)
    }
    assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
    writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
  }
  if (plan.kind === 'prune') {
    // Move shifted user approvals before writing Orca approvals into their former slots.
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
  // Preserve installed approvals while waiting for Codex to report hashes.
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
      // Null means Codex runs this entry without requiring approval.
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
    // Re-read because approval writes and moves can reuse formerly stale keys.
    removeHookTrustEntries(tomlPath, findStale(readHookTrustEntries(tomlPath)))
  } catch (error) {
    // The installed entry remains valid; leftover approvals match no hook.
    console.warn('[codex-real-home-hooks] could not drop stale Orca approvals:', error)
  }
  return 'settled'
}

// Preserve held and untouched slots; stale approvals must carry a known Orca hash.
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

/** Opt-out must move shifted user approvals when removing Orca entries. */
export async function removeRealHomeCodexHookForOptOut(
  codexHashes: readonly CodexHookHashes[],
  home: CodexHookHome = getRealHomeCodexHookHome()
): Promise<'removed' | 'unavailable'> {
  try {
    return await runExclusivelyForCodexTrustConfig(home.tomlPath, async () => {
      const lane = sweepRealHomeCodexHook(home)
      // Unreadable hooks may still need their approvals and ownership ledger; retry cleanup later.
      if (lane === 'removed') {
        // Codex hashes prove ownership even when the hook entry is already gone.
        removeSystemManagedHookTrustEntries(
          home.homePath,
          home.keySourcePaths,
          codexHashes,
          home.tomlPath
        )
      }
      return lane
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] opt-out cleanup failed:', error)
    return 'unavailable'
  }
}
