import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readAgentStateFileSync } from '../agent-state-file-reader'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { tuiStructuredKey, upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  readCodexSettingsBaseline,
  writeCodexSettingsBaseline,
  type CodexSettingsBaseline,
  type CodexSettingsConflict
} from './config-settings-baseline'
import { resolveUntrackedCodexSetting } from './config-settings-conflict-resolution'

// Why: the mirror reverts in-Codex config changes each launch; promotion salvages them by diffing the last baseline.

// Why: only scalars the Codex TUI persists; each key here is written to the user's real ~/.codex, so grow deliberately.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

// Why: the [tui] keys the Codex TUI's user-facing pickers persist (status line,
// terminal title, theme). Like the top-level list, every key here gets written
// into the user's real ~/.codex/config.toml on promotion — grow it deliberately.
export const PROMOTED_CODEX_TUI_SETTING_KEYS = [
  'status_line',
  'status_line_use_colors',
  'terminal_title',
  'theme'
] as const

// Why: promotion diffs and upserts operate on structured keys — top-level keys
// keep their bare name, [tui] keys are namespaced tui.<key> so their baseline
// entries cannot collide with a top-level key of the same name.
const PROMOTED_STRUCTURED_KEYS: readonly string[] = [
  ...PROMOTED_CODEX_SETTING_KEYS,
  ...PROMOTED_CODEX_TUI_SETTING_KEYS.map(tuiStructuredKey)
]

function isPromotedTuiKey(key: string): boolean {
  return (PROMOTED_CODEX_TUI_SETTING_KEYS as readonly string[]).includes(key)
}

// Returns the structured tui key a scanned line's key represents, or null. In
// the preamble it recognizes the dotted `tui.<key>` form a user may hand-author;
// inside the first `[tui]` table body it recognizes the bare `<key>` form Codex
// writes. Both map to the same structured key so either config shape promotes.
function matchTuiStructuredKey(
  keyPath: string[],
  inPreamble: boolean,
  tuiBodyActive: boolean
): string | null {
  if (inPreamble) {
    const tuiKey = keyPath.length === 2 && keyPath[0] === 'tui' ? keyPath[1] : null
    return tuiKey && isPromotedTuiKey(tuiKey) ? tuiStructuredKey(tuiKey) : null
  }
  const tuiKey = keyPath.length === 1 ? keyPath[0] : null
  return tuiBodyActive && tuiKey && isPromotedTuiKey(tuiKey) ? tuiStructuredKey(tuiKey) : null
}

type TopLevelSettingValue = {
  raw: string
  // Why: a multiline string/array value can't be replaced line-by-line, so it's excluded from promotion.
  multiline: boolean
}

function matchPromotedStructuredKey(
  line: string,
  inPreamble: boolean,
  tuiBodyActive: boolean
): { structuredKey: string; raw: string } | null {
  const parsed = parseTomlKeyPath(line)
  if (!parsed || line[parsed.end] !== '=') {
    return null
  }
  const raw = line.slice(parsed.end + 1).trim()
  const topLevelKey = parsed.segments.length === 1 ? parsed.segments[0] : null
  if (
    inPreamble &&
    topLevelKey &&
    (PROMOTED_CODEX_SETTING_KEYS as readonly string[]).includes(topLevelKey)
  ) {
    return { structuredKey: topLevelKey, raw }
  }
  const tuiKey = matchTuiStructuredKey(parsed.segments, inPreamble, tuiBodyActive)
  return tuiKey ? { structuredKey: tuiKey, raw } : null
}

// Why: top-level preamble scalars keep the historical behavior; [tui] keys are
// collected from the first bare [tui] table body or the dotted preamble form,
// keyed by structured path. Any table header (including [tui.*] subtables) ends
// the [tui] body, and [profiles.*]/other tables are still ignored.
function readPromotedSettingValues(configPath: string): Map<string, TopLevelSettingValue> {
  const result = new Map<string, TopLevelSettingValue>()
  if (!existsSync(configPath)) {
    return result
  }
  const lines = readAgentStateFileSync(configPath).split('\n')
  let state = createTomlLineScanState()
  let inPreamble = true
  let tuiTableSeen = false
  let tuiBodyActive = false
  for (const line of lines) {
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        const table = parseTomlTableHeaderPath(header)
        tuiBodyActive =
          table !== null &&
          !table.isArray &&
          table.segments.length === 1 &&
          table.segments[0] === 'tui' &&
          !tuiTableSeen
        if (tuiBodyActive) {
          tuiTableSeen = true
        }
        inPreamble = false
        state = updateTomlLineScanState(state, line)
        continue
      }
      const matched = matchPromotedStructuredKey(line, inPreamble, tuiBodyActive)
      if (matched) {
        const nextState = updateTomlLineScanState(state, line)
        result.set(matched.structuredKey, {
          raw: matched.raw,
          multiline: !isTomlStructuralLine(nextState)
        })
        state = nextState
        continue
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return result
}

/**
 * Records the promotable settings the runtime config.toml holds after a mirror, so the next
 * promotion can tell "value Orca mirrored" from "value Codex wrote for the user".
 * Call after a successful mirror only — advancing past an unpromoted change strands it forever.
 */
export function snapshotCodexRuntimeSettingsBaseline(
  runtimeHomePath = getOrcaManagedCodexHomePath(),
  conflicts: ReadonlyMap<string, CodexSettingsConflict> = new Map()
): void {
  try {
    const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
    // Why: record an empty baseline even for a missing runtime config, so Codex's first write still diffs and promotes.
    const runtimeValues = readPromotedSettingValues(runtimeTomlPath)
    const settings = new Map<string, string | null>()
    for (const key of PROMOTED_STRUCTURED_KEYS) {
      const value = runtimeValues.get(key)
      if (!conflicts.has(key) && !value?.multiline) {
        // Why: explicit nulls distinguish a schema-aware absence from a key added by a later schema.
        settings.set(key, value?.raw ?? null)
      }
    }
    writeCodexSettingsBaseline(runtimeHomePath, { settings, conflicts })
  } catch (error) {
    console.warn('[codex-settings-promotion] failed to snapshot settings baseline', error)
  }
}

export type CodexSettingsPromotionHomes = {
  runtimeHomePath: string
  systemHomePath: string
}

export type CodexSettingsPromotionPlan = {
  conflicts: ReadonlyMap<string, CodexSettingsConflict>
  runtimeValuesToPreserve: ReadonlyMap<string, string | null>
}

function getHostPromotionHomes(): CodexSettingsPromotionHomes {
  return {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
}

/**
 * Promotes in-Codex setting changes from the runtime config.toml into ~/.codex/config.toml.
 * Runs before the config mirror so promoted values survive it instead of reverting.
 * WSL callers pass explicit per-distro homes; default is the host runtime home and ~/.codex.
 */
export function promoteCodexRuntimeSettingsToSystem(
  homes?: CodexSettingsPromotionHomes
): CodexSettingsPromotionPlan | null {
  try {
    return promoteCodexRuntimeSettingsToSystemUnsafe(homes ?? getHostPromotionHomes())
  } catch (error) {
    // Why: promotion is best-effort launch prep; a malformed file must not block Codex launch.
    console.warn('[codex-settings-promotion] failed to promote runtime settings', error)
    return null
  }
}

function promoteCodexRuntimeSettingsToSystemUnsafe(
  homes: CodexSettingsPromotionHomes
): CodexSettingsPromotionPlan {
  const { runtimeHomePath, systemHomePath } = homes
  const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
  const systemTomlPath = join(systemHomePath, 'config.toml')
  if (resolve(runtimeTomlPath) === resolve(systemTomlPath)) {
    return emptyPromotionPlan()
  }
  if (!existsSync(runtimeTomlPath)) {
    return emptyPromotionPlan()
  }
  // Why: without a baseline, a stale runtime value looks like a fresh in-Codex change; skip until the mirror writes one.
  const baseline = readCodexSettingsBaseline(runtimeHomePath)
  if (!baseline) {
    return emptyPromotionPlan()
  }
  const runtimeValues = readPromotedSettingValues(runtimeTomlPath)
  const systemValues = readPromotedSettingValues(systemTomlPath)
  const updates = new Map<string, string>()
  const conflicts = new Map<string, CodexSettingsConflict>()
  const runtimeValuesToPreserve = new Map<string, string | null>()
  collectPromotionChanges({
    baseline,
    runtimeValues,
    systemValues,
    updates,
    conflicts,
    runtimeValuesToPreserve
  })
  if (updates.size === 0) {
    return { conflicts, runtimeValuesToPreserve }
  }
  // Why: a fresh host has no ~/.codex; create it owner-only (holds auth.json) or the atomic write ENOENTs and the mirror wipes it.
  mkdirSync(systemHomePath, { recursive: true, mode: 0o700 })
  const writeTarget = resolvePromotionWriteTarget(systemTomlPath)
  // Why: a dangling symlink may target an unmade dir tree; create its real parent so the atomic temp write has a home.
  mkdirSync(dirname(writeTarget.path), { recursive: true, mode: 0o700 })
  const targetExists = existsSync(writeTarget.path)
  const systemContent = targetExists ? readAgentStateFileSync(writeTarget.path) : ''
  const nextContent = upsertPromotedSettingsInContent(systemContent, updates)
  if (nextContent === systemContent) {
    return { conflicts, runtimeValuesToPreserve }
  }
  if (targetExists && parseWslUncPath(writeTarget.path)) {
    // Why: \\wsl$ 9P symlink metadata is unreliable; write through the existing file to preserve the WSL-side inode.
    writeFileSync(writeTarget.path, nextContent, 'utf-8')
    return { conflicts, runtimeValuesToPreserve }
  }
  writeFileAtomically(writeTarget.path, nextContent, {
    mode: writeTarget.mode
  })
  return { conflicts, runtimeValuesToPreserve }
}

type PromotionCollectionContext = {
  baseline: CodexSettingsBaseline
  runtimeValues: ReadonlyMap<string, TopLevelSettingValue>
  systemValues: ReadonlyMap<string, TopLevelSettingValue>
  updates: Map<string, string>
  conflicts: Map<string, CodexSettingsConflict>
  runtimeValuesToPreserve: Map<string, string | null>
}

function collectPromotionChanges(context: PromotionCollectionContext): void {
  for (const key of PROMOTED_STRUCTURED_KEYS) {
    const runtimeRaw = getComparableRaw(context.runtimeValues.get(key))
    const systemRaw = getComparableRaw(context.systemValues.get(key))
    if (runtimeRaw === undefined || systemRaw === undefined) {
      continue
    }

    const existingConflict = context.baseline.conflicts.get(key)
    if (existingConflict || !context.baseline.settings.has(key)) {
      const resolution = resolveUntrackedCodexSetting(runtimeRaw, systemRaw, existingConflict)
      if (resolution.action === 'promote-runtime') {
        context.updates.set(key, resolution.raw)
      } else if (resolution.action === 'preserve') {
        // Why: a schema-new key has no three-way ancestor; preserve both values until content changes one side.
        context.conflicts.set(key, resolution.conflict)
        context.runtimeValuesToPreserve.set(key, runtimeRaw)
      }
      continue
    }

    if (runtimeRaw === null || runtimeRaw === context.baseline.settings.get(key)) {
      continue
    }
    // Why: ~/.codex remains source of truth when both sides changed from a known baseline.
    if (systemRaw !== context.baseline.settings.get(key)) {
      continue
    }
    context.updates.set(key, runtimeRaw)
  }
}

function getComparableRaw(value: TopLevelSettingValue | undefined): string | null | undefined {
  if (!value) {
    return null
  }
  return value.multiline ? undefined : value.raw
}

function emptyPromotionPlan(): CodexSettingsPromotionPlan {
  return { conflicts: new Map(), runtimeValuesToPreserve: new Map() }
}

// Why: follow an existing dotfile-manager symlink and carry its mode forward so an atomic write can't widen a 0600 config.
function resolvePromotionWriteTarget(systemTomlPath: string): { path: string; mode: number } {
  try {
    const realPath = realpathSync(systemTomlPath)
    return { path: realPath, mode: statSync(realPath).mode & 0o777 }
  } catch {
    // Continue below: realpath also fails for a valid dangling dotfile link.
  }
  try {
    if (lstatSync(systemTomlPath).isSymbolicLink()) {
      const targetPath = resolveDanglingSymlinkTarget(systemTomlPath)
      return { path: targetPath, mode: 0o600 }
    }
  } catch {
    // Missing non-link targets are created owner-only at the requested path.
  }
  return { path: systemTomlPath, mode: 0o600 }
}

function resolveDanglingSymlinkTarget(linkPath: string): string {
  let currentPath = linkPath
  const visited = new Set<string>()
  while (!visited.has(currentPath)) {
    visited.add(currentPath)
    try {
      if (!lstatSync(currentPath).isSymbolicLink()) {
        return currentPath
      }
      currentPath = resolve(dirname(currentPath), readlinkSync(currentPath))
    } catch {
      return currentPath
    }
  }
  // Why: replacing any link in a cycle would destroy dotfile-manager state; abort instead.
  throw new Error(`Codex config symlink cycle at ${linkPath}`)
}
