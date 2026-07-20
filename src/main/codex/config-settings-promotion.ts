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

// Why: the mirror reverts in-Codex config changes each launch; promotion salvages them by diffing the last baseline.

// Why: only scalars the Codex TUI persists; each key here is written to the user's real ~/.codex, so grow deliberately.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

type TopLevelSettingValue = {
  raw: string
  // Why: a multiline string/array value can't be replaced line-by-line, so it's excluded from promotion.
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

// Why: only top-level preamble keys are scanned; rewriting nested [profiles.*] tables isn't worth the risk here.
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
 * Records the promotable settings the runtime config.toml holds after a mirror, so the next
 * promotion can tell "value Orca mirrored" from "value Codex wrote for the user".
 * Call after a successful mirror only — advancing past an unpromoted change strands it forever.
 */
export function snapshotCodexRuntimeSettingsBaseline(
  runtimeHomePath = getOrcaManagedCodexHomePath()
): void {
  try {
    const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
    // Why: record an empty baseline even for a missing runtime config, so Codex's first write still diffs and promotes.
    const settings: Record<string, string> = {}
    for (const [key, value] of readTopLevelSettingValues(runtimeTomlPath)) {
      if (!value.multiline) {
        settings[key] = value.raw
      }
    }
    const file: SettingsBaselineFile = { version: 1, settings }
    const baselinePath = getSettingsBaselinePath(runtimeHomePath)
    const serialized = `${JSON.stringify(file, null, 2)}\n`
    // Why: launch prep runs repeatedly; skip byte-identical rewrites to avoid needless disk writes.
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
 * Promotes in-Codex setting changes from the runtime config.toml into ~/.codex/config.toml.
 * Runs before the config mirror so promoted values survive it instead of reverting.
 * WSL callers pass explicit per-distro homes; default is the host runtime home and ~/.codex.
 */
export function promoteCodexRuntimeSettingsToSystem(homes?: CodexSettingsPromotionHomes): boolean {
  try {
    promoteCodexRuntimeSettingsToSystemUnsafe(homes ?? getHostPromotionHomes())
    return true
  } catch (error) {
    // Why: promotion is best-effort launch prep; a malformed file must not block Codex launch.
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
  // Why: without a baseline, a stale runtime value looks like a fresh in-Codex change; skip until the mirror writes one.
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
    // Why: ~/.codex is source of truth — an outside edit since the baseline wins over the in-Codex change.
    if (system?.raw !== baseline.get(key)) {
      continue
    }
    updates.set(key, runtime.raw)
  }
  if (updates.size === 0) {
    return
  }
  // Why: a fresh host has no ~/.codex; create it owner-only (holds auth.json) or the atomic write ENOENTs and the mirror wipes it.
  mkdirSync(systemHomePath, { recursive: true, mode: 0o700 })
  const writeTarget = resolvePromotionWriteTarget(systemTomlPath)
  // Why: a dangling symlink may target an unmade dir tree; create its real parent so the atomic temp write has a home.
  mkdirSync(dirname(writeTarget.path), { recursive: true, mode: 0o700 })
  const targetExists = existsSync(writeTarget.path)
  const systemContent = targetExists ? readFileSync(writeTarget.path, 'utf-8') : ''
  const nextContent = upsertTopLevelSettingsInContent(systemContent, updates)
  if (targetExists && parseWslUncPath(writeTarget.path)) {
    // Why: \\wsl$ 9P symlink metadata is unreliable; write through the existing file to preserve the WSL-side inode.
    writeFileSync(writeTarget.path, nextContent, 'utf-8')
    return
  }
  writeFileAtomically(writeTarget.path, nextContent, {
    mode: writeTarget.mode
  })
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

  // Why: match the file's existing EOL (CRLF split leaves a trailing \r) so a Windows config doesn't go mixed-EOL.
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
