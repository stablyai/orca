import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { HooksConfig } from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { isPlainObject, readHooksJsonWithRaw } from '../agent-hooks/hooks-json-read'
import { getSystemCodexHomePath } from './codex-home-paths'
import {
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath
} from './config-toml-trust'

export function getRealHomeHooksJsonPath(): string {
  return join(getSystemCodexHomePath(), 'hooks.json')
}

/** Approve spelled and resolved paths because symlinked homes can use either key. */
export function getRealHomeHookKeySourcePaths(
  hooksJsonPath: string = getRealHomeHooksJsonPath()
): [string, ...string[]] {
  const spelled = normalizeCodexHookSourcePath(hooksJsonPath)
  const resolved = getCodexExplicitHomeHookSourcePath(hooksJsonPath)
  return resolved === spelled ? [spelled] : [spelled, resolved]
}

// Keep the pristine backup separate from writeHooksJson's rolling hooks.json.bak.
function getRealHomeHookStateDir(userDataPath: string): string {
  return join(userDataPath, 'codex-real-home-hooks')
}

export class HooksJsonChangedError extends Error {
  constructor() {
    super('Codex hooks.json changed since Orca read it')
    this.name = 'HooksJsonChangedError'
  }
}

export function readRealHomeHooksFileProblem(): string | null {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const { raw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (raw === null) {
    return null
  }
  return isAddableHooksFile(config)
    ? null
    : `Orca cannot add its hook to ${hooksJsonPath}, so Orca shows no status for ~/.codex`
}

// Reject shapes Codex skips so adding Orca hooks cannot clobber unsupported user data.
export function isAddableHooksFile(config: HooksConfig | null): config is HooksConfig {
  return (
    config !== null &&
    Object.keys(config).every((key) => key === 'hooks' || key === 'description') &&
    (config.hooks === undefined ||
      (isPlainObject(config.hooks) && Object.values(config.hooks).every(Array.isArray)))
  )
}

export function assertHooksJsonGeneration(
  hooksJsonPath: string,
  hooksWritePath: string,
  expectedRaw: string | null
): void {
  const currentRaw = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, 'utf-8') : null
  if (currentRaw !== expectedRaw || resolveHooksJsonWritePath(hooksJsonPath) !== hooksWritePath) {
    throw new HooksJsonChangedError()
  }
}

export function backupRealHomeHooksJsonOnce(
  userDataPath: string,
  previousRaw: string | null
): void {
  if (previousRaw === null) {
    return
  }
  const backupDir = getRealHomeHookStateDir(userDataPath)
  const backupPath = join(backupDir, 'hooks.json.pre-orca')
  if (existsSync(backupPath)) {
    return
  }
  // Backup failure must prevent real-home mutation and retain the managed lane.
  mkdirSync(backupDir, { recursive: true })
  writeFileAtomically(backupPath, previousRaw, { mode: 0o600 })
}
