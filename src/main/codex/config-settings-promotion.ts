import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

// Why: the config mirror rewrites the runtime config.toml from ~/.codex on
// every launch (and on background rate-limit fetches), so settings the user
// changes inside Orca-launched Codex silently revert. Promotion diffs the
// runtime file against a baseline of what Orca last wrote — anything that
// differs is a change Codex persisted for the user and belongs in ~/.codex.

// Why: only the user-preference scalars the Codex TUI itself persists
// (/model writes model + model_reasoning_effort, /approvals writes
// approval_policy + sandbox_mode). Every key added here gets written into the
// user's real ~/.codex/config.toml, so grow this list deliberately.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

type TopLevelSettingValue = {
  raw: string
  // Why: a value that opens a multiline string/array cannot be replaced or
  // copied line-by-line safely, so it is excluded from promotion entirely.
  multiline: boolean
}

type SettingsBaselineFile = {
  version: 1
  settings: Record<string, string>
}

function getSettingsBaselinePath(runtimeHomePath: string): string {
  return join(runtimeHomePath, '.orca-config-settings-baseline.json')
}

function readSettingsBaseline(runtimeHomePath: string): Map<string, string> | null {
  const baselinePath = getSettingsBaselinePath(runtimeHomePath)
  if (!existsSync(baselinePath)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(baselinePath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const settings = (parsed as SettingsBaselineFile).settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return null
    }
    const result = new Map<string, string>()
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === 'string') {
        result.set(key, value)
      }
    }
    return result
  } catch {
    return null
  }
}

// Why: only keys in the top-level preamble are scanned — Codex writes profile
// overrides into [profiles.*] tables, and rewriting nested tables surgically
// is not worth the risk for stage-1 promotion.
function readTopLevelSettingValues(configPath: string): Map<string, TopLevelSettingValue> {
  const result = new Map<string, TopLevelSettingValue>()
  if (!existsSync(configPath)) {
    return result
  }
  const lines = readFileSync(configPath, 'utf-8').split('\n')
  let state = createTomlLineScanState()
  for (const line of lines) {
    if (isTomlStructuralLine(state)) {
      if (getTomlTableHeader(line)) {
        break
      }
      const match = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.*?)[ \t\r]*$/.exec(line)
      const key = match?.[1]
      if (key && (PROMOTED_CODEX_SETTING_KEYS as readonly string[]).includes(key)) {
        const nextState = updateTomlLineScanState(state, line)
        result.set(key, { raw: match?.[2] ?? '', multiline: !isTomlStructuralLine(nextState) })
        state = nextState
        continue
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return result
}

/**
 * Records the promotable top-level settings the runtime config.toml holds
 * after a mirror, so the next promotion can tell "value Orca mirrored" apart
 * from "value Codex wrote for the user". Call after a successful mirror only —
 * advancing the baseline past an unpromoted change would strand it forever.
 */
export function snapshotCodexRuntimeSettingsBaseline(
  runtimeHomePath = getOrcaManagedCodexHomePath()
): void {
  try {
    const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
    // Why: a missing runtime config still records an empty baseline — when
    // Codex later creates the file for a user with no ~/.codex/config.toml,
    // that first change must diff against "Orca left nothing" and promote.
    const settings: Record<string, string> = {}
    for (const [key, value] of readTopLevelSettingValues(runtimeTomlPath)) {
      if (!value.multiline) {
        settings[key] = value.raw
      }
    }
    const file: SettingsBaselineFile = { version: 1, settings }
    const baselinePath = getSettingsBaselinePath(runtimeHomePath)
    const serialized = `${JSON.stringify(file, null, 2)}\n`
    // Why: launch preparation can run repeatedly; skip byte-identical rewrites
    // so an unchanged pass does no disk writes.
    if (existsSync(baselinePath) && readFileSync(baselinePath, 'utf-8') === serialized) {
      return
    }
    writeFileSync(baselinePath, serialized, {
      encoding: 'utf-8',
      mode: 0o600
    })
  } catch (error) {
    console.warn('[codex-settings-promotion] failed to snapshot settings baseline', error)
  }
}

export type CodexSettingsPromotionHomes = {
  runtimeHomePath: string
  systemHomePath: string
}

function getHostPromotionHomes(): CodexSettingsPromotionHomes {
  return {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
}

/**
 * Promotes setting changes the user made inside Orca-launched Codex (written
 * by Codex into the runtime config.toml) into ~/.codex/config.toml. Runs
 * before the config mirror so the promoted values survive the same mirror
 * pass instead of reverting. WSL callers pass explicit per-distro homes; the
 * default is the host runtime home and host ~/.codex.
 */
export function promoteCodexRuntimeSettingsToSystem(homes?: CodexSettingsPromotionHomes): boolean {
  try {
    promoteCodexRuntimeSettingsToSystemUnsafe(homes ?? getHostPromotionHomes())
    return true
  } catch (error) {
    // Why: promotion is best-effort launch prep; callers preserve the runtime
    // for retry, while a malformed file must not block Codex launch itself.
    console.warn('[codex-settings-promotion] failed to promote runtime settings', error)
    return false
  }
}

function promoteCodexRuntimeSettingsToSystemUnsafe(homes: CodexSettingsPromotionHomes): void {
  const { runtimeHomePath, systemHomePath } = homes
  const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
  const systemTomlPath = join(systemHomePath, 'config.toml')
  if (resolve(runtimeTomlPath) === resolve(systemTomlPath)) {
    return
  }
  if (!existsSync(runtimeTomlPath)) {
    return
  }
  // Why: without a baseline of what Orca last mirrored (first launch after
  // upgrading to a build with promotion, or a corrupted snapshot), a stale
  // runtime value is indistinguishable from a fresh in-Codex change. Skip
  // this pass — the mirror writes the first baseline and promotion starts on
  // the next one.
  const baseline = readSettingsBaseline(runtimeHomePath)
  if (!baseline) {
    return
  }
  const runtimeValues = readTopLevelSettingValues(runtimeTomlPath)
  const systemValues = readTopLevelSettingValues(systemTomlPath)
  const updates = new Map<string, string>()
  for (const key of PROMOTED_CODEX_SETTING_KEYS) {
    const runtime = runtimeValues.get(key)
    if (!runtime || runtime.multiline) {
      continue
    }
    if (runtime.raw === baseline.get(key)) {
      // Orca mirrored this value and nothing touched it since — not a change.
      continue
    }
    const system = systemValues.get(key)
    if (system?.multiline) {
      continue
    }
    // Why: ~/.codex stays source of truth — if the user also edited it there
    // since the baseline, the outside edit wins over the in-Codex change.
    if (system?.raw !== baseline.get(key)) {
      continue
    }
    updates.set(key, runtime.raw)
  }
  if (updates.size === 0) {
    return
  }
  // Why: a genuinely fresh host has no ~/.codex yet; without the directory
  // the atomic write ENOENTs and the following mirror wipes the setting.
  // Owner-only: the directory holds auth.json and the full user config.
  mkdirSync(systemHomePath, { recursive: true, mode: 0o700 })
  const writeTarget = resolvePromotionWriteTarget(systemTomlPath)
  // Why: a dangling dotfile-manager symlink can point into a directory tree
  // that has not been materialized yet; preserve the link and create its real
  // parent so the atomic temp file can be written beside the target.
  mkdirSync(dirname(writeTarget.path), { recursive: true, mode: 0o700 })
  const targetExists = existsSync(writeTarget.path)
  const systemContent = targetExists ? readFileSync(writeTarget.path, 'utf-8') : ''
  const nextContent = upsertTopLevelSettingsInContent(systemContent, updates)
  if (targetExists && parseWslUncPath(writeTarget.path)) {
    // Why: symlink metadata through the \\wsl$ 9P provider is not reliable
    // enough for realpath/lstat detection, and an atomic rename would replace
    // a WSL-side dotfile symlink with a plain file. Writing through the
    // existing file preserves the Linux-side inode (and its mode).
    writeFileSync(writeTarget.path, nextContent, 'utf-8')
    return
  }
  writeFileAtomically(writeTarget.path, nextContent, {
    mode: writeTarget.mode
  })
}

// Why: promotion rewrites the user's real config.toml. Follow an existing
// symlink (dotfile managers) instead of replacing the link with a plain file,
// and carry the real file's mode forward — an atomic write without a mode
// would widen a user-restricted 0600 config to the process umask default.
// A new or unreadable target is created owner-only.
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
  // Why: replacing any link in a cycle would destroy dotfile-manager state;
  // abort promotion and leave the runtime/baseline intact for manual repair.
  throw new Error(`Codex config symlink cycle at ${linkPath}`)
}

export function upsertTopLevelSettingsInContent(
  content: string,
  updates: Map<string, string>
): string {
  const lines = content.split('\n')
  let state = createTomlLineScanState()
  let preambleEnd = lines.length
  const keyLineIndexes = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(state)) {
      if (getTomlTableHeader(line)) {
        preambleEnd = index
        break
      }
      const match = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=/.exec(line)
      if (match?.[1] && updates.has(match[1])) {
        keyLineIndexes.set(match[1], index)
      }
    }
    state = updateTomlLineScanState(state, line)
  }

  // Why: CRLF configs keep a trailing \r after the split; new lines must use
  // the file's existing endings or a Windows-owned config becomes mixed-EOL.
  const usesCrlf = content.includes('\r\n')
  const insertions: string[] = []
  for (const [key, raw] of updates) {
    const existingIndex = keyLineIndexes.get(key)
    const rendered = `${key} = ${raw}`
    if (existingIndex !== undefined) {
      lines[existingIndex] = lines[existingIndex]?.endsWith('\r') ? `${rendered}\r` : rendered
    } else {
      insertions.push(usesCrlf ? `${rendered}\r` : rendered)
    }
  }
  if (insertions.length > 0) {
    let insertAt = preambleEnd
    while (insertAt > 0 && (lines[insertAt - 1] ?? '').trim() === '') {
      insertAt -= 1
    }
    if (insertAt === preambleEnd && preambleEnd < lines.length) {
      insertions.push(usesCrlf ? '\r' : '')
    }
    lines.splice(insertAt, 0, ...insertions)
  }
  const result = lines.join('\n')
  if (result.endsWith('\n') || result.length === 0) {
    return result
  }
  return result.endsWith('\r') ? `${result}\n` : `${result}${usesCrlf ? '\r\n' : '\n'}`
}
