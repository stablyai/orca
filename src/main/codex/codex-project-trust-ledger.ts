import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveOrcaManagedCodexHomePath } from './codex-home-paths'

// Why (#24697): Codex keeps a project's trust forever, so Orca records which
// `[projects."<path>"]` tables its pre-trust created, per config.toml. Only
// these may be removed when the workspace goes; a table that existed before
// belongs to the user.

export type CodexProjectTrustLedger = {
  /** Config.toml path → project paths whose tables Orca created there. */
  configs: Record<string, string[]>
  /** Paths released from every source whose account-home mirror copies are not yet removed. */
  pendingMirrorCleanup: string[]
}

type CodexProjectTrustLedgerFile = CodexProjectTrustLedger & { version: 1 }

const emptyLedger = (): CodexProjectTrustLedgerFile => ({
  version: 1,
  configs: {},
  pendingMirrorCleanup: []
})

export function getCodexProjectTrustLedgerPath(): string {
  return join(dirname(resolveOrcaManagedCodexHomePath()), 'project-trust-ledger.json')
}

/** `null` means the ledger could not be read; writes must not replace it with a partial one. */
function readLedgerFileOrNull(ledgerPath: string): CodexProjectTrustLedgerFile | null {
  let raw: string
  try {
    raw = readFileSync(ledgerPath, 'utf-8')
  } catch (error) {
    return isDefinitiveAbsence(error) ? emptyLedger() : null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1) {
      return {
        version: 1,
        configs: 'configs' in parsed ? sanitizeConfigs(parsed.configs) : {},
        pendingMirrorCleanup:
          'pendingMirrorCleanup' in parsed ? sanitizePaths(parsed.pendingMirrorCleanup) : []
      }
    }
  } catch {
    // Fall through: a corrupt ledger only means older entries are never removed.
  }
  return emptyLedger()
}

function sanitizePaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((path): path is string => typeof path === 'string')
    : []
}

function sanitizeConfigs(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const configs: Record<string, string[]> = {}
  for (const [configPath, paths] of Object.entries(value)) {
    const strings = sanitizePaths(paths)
    if (strings.length > 0) {
      configs[configPath] = strings
    }
  }
  return configs
}

function updateLedgerFile(
  ledgerPath: string,
  update: (file: CodexProjectTrustLedgerFile) => boolean
): void {
  const file = readLedgerFileOrNull(ledgerPath)
  if (!file || !update(file)) {
    return
  }
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 })
  // Why: a torn write would parse as empty and drop every record that enables cleanup.
  writeFileAtomically(ledgerPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

export function readCodexProjectTrustLedger(
  ledgerPath = getCodexProjectTrustLedgerPath()
): CodexProjectTrustLedger {
  const { configs, pendingMirrorCleanup } = readLedgerFileOrNull(ledgerPath) ?? emptyLedger()
  return { configs, pendingMirrorCleanup }
}

export function recordCodexProjectTrustCreated(
  configPath: string,
  projectPath: string,
  ledgerPath = getCodexProjectTrustLedgerPath()
): void {
  updateLedgerFile(ledgerPath, (file) => {
    const paths = file.configs[configPath] ?? []
    if (paths.includes(projectPath)) {
      return false
    }
    file.configs[configPath] = [...paths, projectPath]
    return true
  })
}

/**
 * Stops tracking `released` paths per config and queues `pendingMirrorCleanup`
 * in one write, so a crash cannot drop a record before its mirror copies go.
 */
export function releaseCodexProjectTrust(
  released: Readonly<Record<string, readonly string[]>>,
  pendingMirrorCleanup: readonly string[],
  ledgerPath = getCodexProjectTrustLedgerPath()
): void {
  updateLedgerFile(ledgerPath, (file) => {
    for (const [configPath, projectPaths] of Object.entries(released)) {
      const kept = (file.configs[configPath] ?? []).filter((path) => !projectPaths.includes(path))
      if (kept.length === 0) {
        delete file.configs[configPath]
      } else {
        file.configs[configPath] = kept
      }
    }
    file.pendingMirrorCleanup = [
      ...new Set([...file.pendingMirrorCleanup, ...pendingMirrorCleanup])
    ]
    return true
  })
}

export function clearPendingCodexMirrorCleanup(
  projectPaths: readonly string[],
  ledgerPath = getCodexProjectTrustLedgerPath()
): void {
  updateLedgerFile(ledgerPath, (file) => {
    const kept = file.pendingMirrorCleanup.filter((path) => !projectPaths.includes(path))
    if (kept.length === file.pendingMirrorCleanup.length) {
      return false
    }
    file.pendingMirrorCleanup = kept
    return true
  })
}
