import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { dirname, join } from 'node:path'
import { resolveOrcaManagedCodexHomePath } from './codex-home-paths'
import { normalizeCodexProjectPathForLookup } from './config-toml-trust'

// Cache verified grants per home to avoid repeating launch-blocking RPCs.

export type CodexTrustGrantBinaryStamp =
  | { kind: 'native'; path: string; size: number; mtimeMs: number }
  | { kind: 'wsl'; distro: string; path: string; version: string }

export type CodexTrustGrantLedgerEntry = {
  /** getCodexHookTrustSignature() of the granted hook identity. */
  signature: string
  /** Codex-computed hash verified as trusted via hooks/list. */
  trustedHash: string
}

export type CodexTrustGrantLedgerHome = {
  binary: CodexTrustGrantBinaryStamp | null
  /** Keyed by normalizeHookTrustKeyForLookup(trust key). */
  entries: Record<string, CodexTrustGrantLedgerEntry>
}

type CodexTrustGrantLedgerFile = {
  version: 1
  homes: Record<string, CodexTrustGrantLedgerHome>
}

// Reading grants must not create Orca's managed home.
export function getCodexTrustGrantLedgerPath(): string {
  return join(dirname(resolveOrcaManagedCodexHomePath()), 'trust-grant-ledger.json')
}

export function getCodexTrustGrantHomeKey(runtimeHomePath: string): string {
  return normalizeCodexProjectPathForLookup(runtimeHomePath)
}

/** Return null on read errors so writes cannot erase other homes' unreadable grants. */
function readLedgerFileOrNull(ledgerPath: string): CodexTrustGrantLedgerFile | null {
  const empty: CodexTrustGrantLedgerFile = { version: 1, homes: {} }
  let rawLedger: string
  try {
    rawLedger = readFileSync(ledgerPath, 'utf-8')
  } catch (error) {
    return isDefinitiveAbsence(error) ? empty : null
  }
  try {
    const parsed: unknown = JSON.parse(rawLedger)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as CodexTrustGrantLedgerFile).version !== 1
    ) {
      return empty
    }
    const homes = (parsed as CodexTrustGrantLedgerFile).homes
    if (!homes || typeof homes !== 'object' || Array.isArray(homes)) {
      return empty
    }
    return { version: 1, homes }
  } catch {
    // Corruption costs another grant session but must not block hook installation.
    return empty
  }
}

function readLedgerFile(ledgerPath: string): CodexTrustGrantLedgerFile {
  return readLedgerFileOrNull(ledgerPath) ?? { version: 1, homes: {} }
}

function persistLedgerFile(ledgerPath: string, file: CodexTrustGrantLedgerFile): void {
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 })
  writeFileSync(ledgerPath, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
}

export function readCodexTrustGrantLedgerHome(
  runtimeHomePath: string,
  ledgerPath = getCodexTrustGrantLedgerPath()
): CodexTrustGrantLedgerHome | null {
  const home = readLedgerFile(ledgerPath).homes[getCodexTrustGrantHomeKey(runtimeHomePath)]
  if (!home || typeof home !== 'object' || Array.isArray(home)) {
    return null
  }
  if (!home.entries || typeof home.entries !== 'object' || Array.isArray(home.entries)) {
    return null
  }
  return home
}

export function writeCodexTrustGrantLedgerHome(
  runtimeHomePath: string,
  home: CodexTrustGrantLedgerHome,
  ledgerPath = getCodexTrustGrantLedgerPath()
): void {
  const file = readLedgerFileOrNull(ledgerPath)
  if (!file) {
    return
  }
  file.homes[getCodexTrustGrantHomeKey(runtimeHomePath)] = home
  persistLedgerFile(ledgerPath, file)
}

export function removeCodexTrustGrantLedgerHome(
  runtimeHomePath: string,
  ledgerPath = getCodexTrustGrantLedgerPath()
): void {
  const file = readLedgerFile(ledgerPath)
  const homeKey = getCodexTrustGrantHomeKey(runtimeHomePath)
  if (!(homeKey in file.homes)) {
    return
  }
  delete file.homes[homeKey]
  persistLedgerFile(ledgerPath, file)
}

export function binaryStampsMatch(
  recorded: CodexTrustGrantBinaryStamp | null,
  current: CodexTrustGrantBinaryStamp | null
): boolean {
  if (recorded === null || current === null) {
    // Two unavailable stamps avoid endless re-grants; config and signature checks still apply.
    return recorded === null && current === null
  }
  if (recorded.kind === 'wsl' || current.kind === 'wsl') {
    return (
      recorded.kind === 'wsl' &&
      current.kind === 'wsl' &&
      recorded.distro === current.distro &&
      recorded.path === current.path &&
      recorded.version === current.version
    )
  }
  return (
    recorded.path === current.path &&
    recorded.size === current.size &&
    recorded.mtimeMs === current.mtimeMs
  )
}
