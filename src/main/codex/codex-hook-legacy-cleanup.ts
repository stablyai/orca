import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  hookDefinitionHasManagedCommand,
  readHooksJsonWithRaw,
  removeManagedCommands,
  writeHooksJson
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { findManagedTomlBlocks } from '../agent-hooks/managed-toml-ownership'
import { writeConfigAtomically, type CodexTrustEntry } from './config-toml-trust'
import {
  getConfigPath,
  getSystemCodexConfigTomlPath,
  getSystemConfigPath
} from './codex-hook-definition'
import { isRetiredCodexHookCommand } from './codex-hook-retired-commands'
import { getSystemCodexHomePath } from './codex-home-paths'
import {
  collectManagedTrustEntries,
  removeSelfComputedMatchingTrustEntries
} from './codex-hook-trust-cleanup'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { getRealHomeHookKeySourcePaths } from './codex-real-home-hooks-json'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-moves'

const LEGACY_ORCA_PROFILE_NAME = 'orca-agent-status'
const LEGACY_ORCA_PROFILE_BLOCK_START = '# BEGIN ORCA AGENT STATUS HOOKS'
const LEGACY_ORCA_PROFILE_BLOCK_END = '# END ORCA AGENT STATUS HOOKS'

function getLegacyCodexProfileTomlPath(): string {
  return join(getSystemCodexHomePath(), `${LEGACY_ORCA_PROFILE_NAME}.config.toml`)
}

export function cleanupLegacySystemManagedHooks(): Promise<void> {
  // Why: shares the real-home lane with the ~/.codex reconcile; both
  // write the user's ~/.codex/hooks.json and its trust in config.toml.
  return runExclusivelyForCodexTrustConfig(
    getSystemCodexConfigTomlPath(),
    sweepLegacySystemManagedHooks
  )
}

/**
 * Removes only retired Orca command forms from the user's ~/.codex/hooks.json.
 *
 * Why never the current entry or its trust: every Orca instance on this HOME
 * shares that entry, and this runs on every install, including launch prep for
 * any pane. Removing it is reserved for an explicit opt-out.
 */
async function sweepLegacySystemManagedHooks(): Promise<void> {
  const legacyConfigPath = getSystemConfigPath()
  const runtimeConfigPath = getConfigPath()
  if (legacyConfigPath === runtimeConfigPath) {
    return
  }

  // Why: the pre-write guard below compares against these bytes; a separate
  // later read would let a concurrent save land between parse and snapshot.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(legacyConfigPath)
  if (!config?.hooks || previousRaw === null) {
    return
  }

  // Why every spelling: with a symlinked home, Codex may have approved the
  // retired hook under its resolved key too.
  const sourcePaths = getRealHomeHookKeySourcePaths()
  const nextHooks = { ...config.hooks }
  const trustEntries: CodexTrustEntry[] = []
  let removedManagedHook = false
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    for (const sourcePath of sourcePaths) {
      // Why: user hook configs can be large; avoid the argument limit from push(...entries).
      for (const entry of collectManagedTrustEntries(
        sourcePath,
        eventName,
        definitions,
        isRetiredCodexHookCommand
      )) {
        trustEntries.push(entry)
      }
    }
    const cleaned = removeManagedCommands(definitions, isRetiredCodexHookCommand)
    removedManagedHook ||= definitions.some((definition) =>
      hookDefinitionHasManagedCommand(definition, isRetiredCodexHookCommand)
    )
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  // Why: Codex hooks moved to Orca's managed CODEX_HOME in #2350; hooks from before then would keep external Codex sessions reporting into Orca.
  if (removedManagedHook) {
    // Why: this is the user's system hooks file, not Orca's runtime copy.
    // Remove only retired Orca hook entries and preserve other managers' metadata.
    const hooksWritePath = resolveHooksJsonWritePath(legacyConfigPath)
    mutateRealHomeHooksPreservingUserTrust({
      sourcePaths,
      tomlPath: getSystemCodexConfigTomlPath(),
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        if (
          readFileSync(legacyConfigPath, 'utf-8') !== previousRaw ||
          resolveHooksJsonWritePath(legacyConfigPath) !== hooksWritePath
        ) {
          // Why: another process may have saved since the read; never replace
          // that newer dotfiles generation with this stale parse.
          throw new Error('System Codex hooks changed since Orca read them')
        }
        writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
      }
    })
    removeSelfComputedMatchingTrustEntries(getSystemCodexConfigTomlPath(), trustEntries)
  }
}

export function stripLegacyManagedProfileBlock(content: string): string {
  const regions = findManagedTomlBlocks(content, {
    startMarker: LEGACY_ORCA_PROFILE_BLOCK_START,
    endMarker: LEGACY_ORCA_PROFILE_BLOCK_END
  })
  // A stray marker above a complete block must not hide it: take the first
  // terminated region and leave the orphan (and the user text around it) alone.
  const region = regions.find((candidate) => candidate.terminated) ?? regions[0]
  if (!region) {
    return content
  }
  if (!region.terminated) {
    // #18861: deleting to EOF took user text appended below the block. This
    // legacy body's shape is not knowable from current source, so there is
    // nothing to recognize it by; leave the whole thing alone. The stale profile
    // is inert (runtime CODEX_HOME supersedes it), so that costs nothing next to
    // destroying the user's trust entries.
    return content
  }
  // Rejoin with the file's own terminator; a bare \n seam here left Windows
  // configs with mixed endings.
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const before = content.slice(0, region.markerOffset).replace(/[ \t]*(?:\r?\n)*$/, '')
  const after = content.slice(region.endOffset).replace(/^(?:\r?\n)+/, '')
  if (!before) {
    return after
  }
  if (!after) {
    return before.endsWith('\n') ? before : `${before}${eol}`
  }
  return `${before}${eol}${eol}${after}`
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
