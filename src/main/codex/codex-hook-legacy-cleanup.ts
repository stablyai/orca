import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand,
  readHooksJsonWithRaw,
  removeManagedCommands,
  writeHooksJson
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { writeConfigAtomically, type CodexTrustEntry } from './config-toml-trust'
import {
  getConfigPath,
  getSystemCodexConfigTomlPath,
  getSystemConfigPath
} from './codex-hook-definition'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { getSystemCodexHomePath } from './codex-home-paths'
import {
  collectManagedTrustEntries,
  removeSelfComputedMatchingTrustEntries,
  removeSystemManagedHookTrustEntries
} from './codex-hook-trust-cleanup'
import { readCodexTrustGrantLedgerHomeForReconciliation } from './codex-managed-trust-reconciliation'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-rebase'

const LEGACY_ORCA_PROFILE_NAME = 'orca-agent-status'
const LEGACY_ORCA_PROFILE_BLOCK_START = '# BEGIN ORCA AGENT STATUS HOOKS'
const LEGACY_ORCA_PROFILE_BLOCK_END = '# END ORCA AGENT STATUS HOOKS'

// Why: when the real-home lane owns ~/.codex/hooks.json (system-default flag ON
// with hooks enabled), the legacy system-home sweep must stand down or every
// managed install would delete the entry the real-home installer just wrote.
// Injected as a gate because this module is bundled into plain-node CLI entries
// that have no settings store; the CLI default keeps the sweep active.
let systemCodexHomeHookSweepSuppressed: () => boolean = () => false

export function setSystemCodexHomeHookSweepSuppressed(gate: () => boolean): void {
  systemCodexHomeHookSweepSuppressed = gate
}

function getLegacyCodexProfileTomlPath(): string {
  return join(getSystemCodexHomePath(), `${LEGACY_ORCA_PROFILE_NAME}.config.toml`)
}

export function cleanupLegacySystemManagedHooks(): Promise<void> {
  // Why: shares the real-home lane with ensureRealHomeCodexHookState — both
  // capture, mutate and roll back the user's ~/.codex/config.toml.
  return runExclusivelyForCodexTrustConfig(
    getSystemCodexConfigTomlPath(),
    sweepLegacySystemManagedHooks
  )
}

async function sweepLegacySystemManagedHooks(): Promise<void> {
  if (systemCodexHomeHookSweepSuppressed()) {
    return
  }
  const legacyConfigPath = getSystemConfigPath()
  const runtimeConfigPath = getConfigPath()
  if (legacyConfigPath === runtimeConfigPath) {
    return
  }

  const systemHomePath = getSystemCodexHomePath()
  const hasRecordedRealHomeGrant =
    readCodexTrustGrantLedgerHomeForReconciliation(systemHomePath) !== null
  // Why: the pre-write guard below compares against these bytes; a separate
  // later read would let a concurrent save land between parse and snapshot.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(legacyConfigPath)
  // Why: `config === null` with no raw is the "could not read" answer, not the
  // "no hooks here" one — the branch below removes managed trust entries AND
  // their grant-ledger record, so acting on it would discard approvals over a
  // read that merely failed. A genuine absence still returns `config: {}`.
  if (config === null && previousRaw === null) {
    return
  }
  if (!config?.hooks || previousRaw === null) {
    if (hasRecordedRealHomeGrant) {
      removeSystemManagedHookTrustEntries(systemHomePath, legacyConfigPath)
    }
    return
  }

  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const nextHooks = { ...config.hooks }
  const trustEntries: CodexTrustEntry[] = []
  let removedManagedHook = false
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const eventTrustEntries = collectManagedTrustEntries(
      legacyConfigPath,
      eventName,
      definitions,
      isManagedCommand
    )
    // Why: user hook configs can be large; avoid the argument limit from push(...entries).
    for (const entry of eventTrustEntries) {
      trustEntries.push(entry)
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    removedManagedHook ||= definitions.some((definition) =>
      hookDefinitionHasManagedCommand(definition, isManagedCommand)
    )
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  // Why: Codex hooks moved to Orca's managed CODEX_HOME; stale ~/.codex entries would keep external Codex sessions reporting into Orca.
  if (removedManagedHook) {
    // Why: this is the user's system hooks file, not Orca's runtime copy.
    // Remove only stale Orca hook entries and preserve other managers' metadata.
    const hooksWritePath = resolveHooksJsonWritePath(legacyConfigPath)
    const previousMode = statSync(hooksWritePath).mode
    await mutateRealHomeHooksPreservingUserTrust({
      sourcePath: legacyConfigPath,
      runtimeHomePath: systemHomePath,
      tomlPath: getSystemCodexConfigTomlPath(),
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        if (
          readFileSync(legacyConfigPath, 'utf-8') !== previousRaw ||
          resolveHooksJsonWritePath(legacyConfigPath) !== hooksWritePath
        ) {
          // Why: the pre-mutation RPC may overlap a user save; downgrade must
          // never replace that newer dotfiles generation with our stale parse.
          throw new Error('System Codex hooks changed during trust repair')
        }
        writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
      },
      restoreHooks: () => writeFileAtomically(hooksWritePath, previousRaw, { mode: previousMode })
    })
    // Why: stale dev/version entries can reference an older managed script
    // path that is not represented by the current grant ledger.
    removeSelfComputedMatchingTrustEntries(getSystemCodexConfigTomlPath(), trustEntries)
  }
  if (removedManagedHook || hasRecordedRealHomeGrant) {
    // Why: the ledger recognizes Codex-computed hashes and remains a retry
    // marker if a prior cleanup removed hooks.json but could not update TOML.
    removeSystemManagedHookTrustEntries(systemHomePath, legacyConfigPath)
  }
}

function stripLegacyManagedProfileBlock(content: string): string {
  const start = content.indexOf(LEGACY_ORCA_PROFILE_BLOCK_START)
  if (start === -1) {
    return content
  }
  const endMarker = content.indexOf(LEGACY_ORCA_PROFILE_BLOCK_END, start)
  const end = endMarker === -1 ? content.length : endMarker + LEGACY_ORCA_PROFILE_BLOCK_END.length
  const before = content.slice(0, start).replace(/[ \t]*(?:\r?\n)*$/, '')
  const after = content.slice(end).replace(/^(?:\r?\n)+/, '')
  if (!before) {
    return after
  }
  if (!after) {
    return before.endsWith('\n') ? before : `${before}\n`
  }
  return `${before}\n\n${after}`
}

function cleanupLegacyCodexProfileHooks(): void {
  const profilePath = getLegacyCodexProfileTomlPath()
  if (!existsSync(profilePath)) {
    return
  }

  const existing = readFileSync(profilePath, 'utf-8')
  const next = stripLegacyManagedProfileBlock(existing)
  if (next === existing) {
    return
  }
  // Why: #2778 wrote Orca hooks into a Codex profile file; runtime CODEX_HOME supersedes it, so remove only Orca's marked block.
  if (next.trim().length === 0) {
    unlinkSync(profilePath)
  } else {
    writeConfigAtomically(profilePath, next)
  }
}

export async function cleanupLegacyManagedHookRepresentations(): Promise<void> {
  try {
    await cleanupLegacySystemManagedHooks()
    cleanupLegacyCodexProfileHooks()
  } catch (error) {
    console.warn('[codex-hook-service] failed to clean legacy Codex hooks', error)
  }
}
