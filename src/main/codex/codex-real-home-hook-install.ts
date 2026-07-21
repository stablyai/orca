import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJsonWithRaw,
  removeManagedCommands,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import {
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS,
  grantManagedCodexHookTrust,
  type CodexTrustGrantFallbackReason
} from './codex-hook-trust-grant'
import { removeCodexManagedHookTrustEntries } from './codex-managed-trust-reconciliation'
import { getCodexManagedHookInstallMaterial } from './hook-service'
import { getSystemCodexHomePath } from './codex-home-paths'
import type { CodexTrustEntry } from './config-toml-trust'
import { restoreCodexTrustConfig } from './codex-trust-config-rollback'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-rebase'

/**
 * Real-home Codex hook lane for the system-default selection (flag ON).
 *
 * - 'pending': no attempt yet this process; routing may optimistically use the
 *   real home (reads are hook-free and the install runs before pane spawns).
 * - 'installed': entry appended LAST in ~/.codex/hooks.json and trusted by
 *   codex itself through the app-server grant client.
 * - 'unavailable': the grant lane could not trust the entry (old binary,
 *   unsupported RPC, verify failure). The entry is rolled back and the host
 *   stays on the managed-home lane.
 * - 'removed': hooks are opted out; Orca entries are swept from the real home.
 */
export type RealHomeCodexHookLane = 'pending' | 'installed' | 'unavailable' | 'removed'

let currentLane: RealHomeCodexHookLane = 'pending'
let installRetryAfterMs = 0

export function getRealHomeCodexHookLane(): RealHomeCodexHookLane {
  return currentLane
}

/**
 * Routing gate consumed by CodexRuntimeHomeService. Both a failed install and
 * a failed opt-out cleanup use the managed lane so no half-mutated hook state
 * can diverge from PTY, rate-limit, or commit-message routing.
 */
export function isRealHomeCodexHookLaneUsable(): boolean {
  return currentLane !== 'unavailable'
}

function getRealHomeHooksJsonPath(): string {
  return join(getSystemCodexHomePath(), 'hooks.json')
}

function getRealHomeConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

/** Orca-side state dir; nothing extra is ever written into the user's ~/.codex. */
function getRealHomeHookStateDir(userDataPath: string): string {
  return join(userDataPath, 'codex-real-home-hooks')
}

function assertHooksJsonGeneration(
  hooksJsonPath: string,
  hooksWritePath: string,
  expectedRaw: string | null
): void {
  const currentRaw = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, 'utf-8') : null
  if (currentRaw !== expectedRaw || resolveHooksJsonWritePath(hooksJsonPath) !== hooksWritePath) {
    // Why: the pre-mutation RPC can overlap a user's editor save. Abort rather
    // than atomically replacing a newer file with the stale parsed snapshot.
    throw new Error('Codex hooks.json changed while Orca prepared its trust repair')
  }
}

/**
 * Ensures the real-home hook state matches the settings: installs and trusts
 * the Orca status hook when enabled, sweeps it when opted out. Idempotent and
 * synchronous (launch prep); repeat calls are cheap — an unchanged hooks.json
 * write no-ops and a valid grant ledger skips the RPC session entirely.
 * Never throws: any failure logs and leaves the host on the managed lane.
 */
export function ensureRealHomeCodexHookState(args: {
  hooksEnabled: boolean
  userDataPath: string
}): RealHomeCodexHookLane {
  // Why: the grant client caches failed probes, but mutating and rolling back
  // hooks.json before consulting it still adds synchronous work to every pane.
  if (args.hooksEnabled && currentLane === 'unavailable' && Date.now() < installRetryAfterMs) {
    return currentLane
  }
  try {
    currentLane = args.hooksEnabled
      ? installRealHomeCodexHook(args.userDataPath)
      : sweepRealHomeCodexHook()
    if (!args.hooksEnabled || currentLane === 'installed') {
      installRetryAfterMs = 0
    }
  } catch (error) {
    console.warn('[codex-real-home-hooks] ensure failed; staying on managed lane:', error)
    currentLane = 'unavailable'
    if (args.hooksEnabled) {
      installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    }
  }
  return currentLane
}

function installRealHomeCodexHook(userDataPath: string): RealHomeCodexHookLane {
  const material = getCodexManagedHookInstallMaterial()
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Why: the generation guard compares against these bytes before writing; a
  // separate later read would let a concurrent save land between parse and
  // snapshot and be silently overwritten by the stale parse.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config) {
    // Why: an unparseable user file must never be clobbered; without a hook
    // entry the managed lane keeps status working for this host.
    console.warn('[codex-real-home-hooks] could not parse', hooksJsonPath, '- managed lane kept')
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return 'unavailable'
  }
  if (Object.keys(config).some((key) => key !== 'hooks')) {
    // Why: Codex rejects unknown root keys instead of ignoring them. Avoid a
    // transient rewrite of a user-owned file that the trust RPC cannot load.
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return 'unavailable'
  }

  // Why: the same script the managed lane maintains; deploying here too keeps
  // host-connect ordering independent of the managed installer loop.
  writeManagedScript(material.scriptPath, material.script)

  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  const managedEntries: CodexTrustEntry[] = []
  for (const eventName of material.events) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const reconciled = reconcileManagedHookDefinition(current, isManagedCommand, material.command)
    nextHooks[eventName] = reconciled.definitions
    managedEntries.push({
      sourcePath: hooksJsonPath,
      eventLabel: material.eventLabel[eventName],
      groupIndex: reconciled.groupIndex,
      handlerIndex: reconciled.handlerIndex,
      command: material.command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    })
  }
  // Why: sweep stale Orca entries out of events the managed lane no longer
  // subscribes to, mirroring the managed installer's upgrade behavior.
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if ((material.events as readonly string[]).includes(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  const previousMode = previousRaw === null ? undefined : statSync(hooksWritePath).mode
  backupRealHomeHooksJsonOnce(userDataPath, previousRaw)
  // Why: unknown top-level fields belong to the user (other managers'
  // metadata); unlike the managed-home writer, preserve them verbatim.
  const trustConfigSnapshot = mutateRealHomeHooksPreservingUserTrust({
    sourcePath: hooksJsonPath,
    runtimeHomePath: getSystemCodexHomePath(),
    tomlPath: getRealHomeConfigTomlPath(),
    beforeHooks: config.hooks ?? {},
    afterHooks: nextHooks,
    writeHooks: () => {
      assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
      writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks } as HooksConfig, {
        preserveMode: true
      })
    },
    restoreHooks: () => restoreRealHomeHooksJson(hooksWritePath, previousRaw, previousMode)
  })

  const grant = grantManagedCodexHookTrust({
    runtimeHomePath: getSystemCodexHomePath(),
    tomlPath: getRealHomeConfigTomlPath(),
    managedCommand: material.command,
    managedEntries,
    host: { kind: 'native' },
    useDefaultCodexHome: true
  })
  if (grant.lane === 'rpc') {
    return 'installed'
  }

  // Why: never leave an untrusted Orca entry in the user's real home — it
  // would surface as "Hooks need review". Roll the file back to its prior
  // bytes and keep this host on the managed-home lane; the grant client
  // already logged the fallback reason.
  try {
    restoreRealHomeHooksJson(hooksWritePath, previousRaw, previousMode)
  } finally {
    // Why: a user-trust rebase may have succeeded before the managed grant
    // failed. Roll both files back to the same pre-mutation generation.
    if (trustConfigSnapshot) {
      restoreCodexTrustConfig(getRealHomeConfigTomlPath(), trustConfigSnapshot)
    }
  }
  installRetryAfterMs = getInstallRetryAfterMs(grant.reason)
  console.warn(
    `[codex-real-home-hooks] trust grant unavailable (${grant.reason}); entry rolled back, managed lane kept`
  )
  return 'unavailable'
}

function reconcileManagedHookDefinition(
  current: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean,
  command: string
): { definitions: HookDefinition[]; groupIndex: number; handlerIndex: number } {
  const directCommandKeys = ['command', 'bash', 'powershell'] as const
  const hasManagedDirectCommand = current.some((definition) =>
    directCommandKeys.some((key) => isManagedCommand(definition[key]))
  )
  const nestedLocations = current.flatMap((definition, groupIndex) =>
    Array.isArray(definition.hooks)
      ? definition.hooks.flatMap((hook, handlerIndex) =>
          isManagedCommand(hook.command) ? [{ groupIndex, handlerIndex }] : []
        )
      : []
  )
  if (!hasManagedDirectCommand && nestedLocations.length === 1) {
    const { groupIndex, handlerIndex } = nestedLocations[0]!
    const definition = current[groupIndex]!
    const hasDirectCommand = directCommandKeys.some((key) => typeof definition[key] === 'string')
    if (definition.matcher === undefined && !hasDirectCommand) {
      const definitions = [...current]
      // Why: users can append groups or handlers after Orca's first install.
      // Reusing the exact slot preserves all later positional trust keys.
      const hooks = [...definition.hooks!]
      hooks[handlerIndex] = buildManagedCommandHook(command)
      definitions[groupIndex] = { ...definition, hooks }
      return { definitions, groupIndex, handlerIndex }
    }
  }

  const cleaned = removeManagedCommands(current, isManagedCommand)
  // Why: first install appends LAST so no existing user trust position shifts.
  return {
    definitions: [...cleaned, { hooks: [buildManagedCommandHook(command)] }],
    groupIndex: cleaned.length,
    handlerIndex: 0
  }
}

function getInstallRetryAfterMs(reason: CodexTrustGrantFallbackReason): number {
  return reason === 'unsupported' || reason === 'unsupported-cached' || reason === 'disabled'
    ? Number.POSITIVE_INFINITY
    : Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
}

function sweepRealHomeCodexHook(): RealHomeCodexHookLane {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  // Why: single read — the pre-write generation guard must compare against
  // the exact bytes this sweep's parse came from.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config?.hooks || previousRaw === null) {
    return 'removed'
  }
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const material = getCodexManagedHookInstallMaterial()
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  let removedAny = false
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (
      cleaned.length !== definitions.length ||
      cleaned.some((definition, index) => definition !== definitions[index])
    ) {
      removedAny = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  if (removedAny) {
    const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
    const previousMode = statSync(hooksWritePath).mode
    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: hooksJsonPath,
      runtimeHomePath: getSystemCodexHomePath(),
      tomlPath: getRealHomeConfigTomlPath(),
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        writeHooksJson(
          hooksWritePath,
          {
            ...config,
            hooks: nextHooks
          } as HooksConfig,
          { preserveMode: true }
        )
      },
      restoreHooks: () => restoreRealHomeHooksJson(hooksWritePath, previousRaw, previousMode)
    })
    // Why: dead [hooks.state] blocks for a removed hook are Orca-owned records;
    // dropping them keeps the user's config.toml from accumulating orphans.
    // Verify ownership by the expected hash or grant ledger: stale/mixed hook
    // groups must never make Orca delete a user's trust record at the same key.
    try {
      removeCodexManagedHookTrustEntries({
        tomlPath: getRealHomeConfigTomlPath(),
        runtimeHomePath: getSystemCodexHomePath(),
        sourcePath: hooksJsonPath,
        command: material.command,
        managedEventLabels: new Set(Object.values(material.eventLabel)),
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      })
    } catch (error) {
      console.warn('[codex-real-home-hooks] failed to drop Orca trust entries:', error)
    }
  }
  return 'removed'
}

/** One-time pristine copy of the user's file, kept under Orca's userData. */
function backupRealHomeHooksJsonOnce(userDataPath: string, previousRaw: string | null): void {
  if (previousRaw === null) {
    return
  }
  const backupDir = getRealHomeHookStateDir(userDataPath)
  const backupPath = join(backupDir, 'hooks.json.pre-orca')
  if (existsSync(backupPath)) {
    return
  }
  // Why: this lane mutates the user's real Codex home. If the required
  // pristine recovery copy cannot be created, keep the managed lane intact.
  mkdirSync(backupDir, { recursive: true })
  writeFileAtomically(backupPath, previousRaw, { mode: 0o600 })
}

function restoreRealHomeHooksJson(
  hooksJsonPath: string,
  previousRaw: string | null,
  previousMode?: number
): void {
  if (previousRaw === null) {
    if (existsSync(hooksJsonPath)) {
      unlinkSync(hooksJsonPath)
    }
    return
  }
  // Why: rollback is part of the safety boundary. Use the shared atomic
  // writer so Windows file-lock retries and failed-temp cleanup are covered.
  writeFileAtomically(hooksJsonPath, previousRaw, { mode: previousMode })
}

export const _internals = {
  setLaneForTesting(lane: RealHomeCodexHookLane): void {
    currentLane = lane
    installRetryAfterMs = 0
  }
}
