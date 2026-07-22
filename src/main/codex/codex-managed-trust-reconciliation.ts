import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  normalizeHookTrustKeyForLookup,
  normalizeCodexHookSourcePath,
  parseTrustKey,
  readHookTrustEntries,
  readHookTrustEntriesFromContent,
  removeHookTrustEntries,
  removeHookTrustEntriesFromContent,
  type CodexEventLabel,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import {
  readCodexTrustGrantLedgerHome,
  removeCodexTrustGrantLedgerHome,
  type CodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'

export function readCodexTrustGrantLedgerHomeForReconciliation(
  runtimeHomePath: string
): CodexTrustGrantLedgerHome | null {
  try {
    return readCodexTrustGrantLedgerHome(runtimeHomePath)
  } catch {
    return null
  }
}

export function getCodexLedgerTrustedHash(
  ledgerHome: CodexTrustGrantLedgerHome | null,
  key: string,
  expectedEntry: CodexTrustEntry
): string | null {
  const granted = ledgerHome?.entries[normalizeHookTrustKeyForLookup(key)]
  return granted?.trustedHash && granted.signature === getCodexHookTrustSignature(expectedEntry)
    ? granted.trustedHash
    : null
}

function addLedgerRecognizedHashes(
  hashes: Set<string>,
  ledgerHomes: readonly (CodexTrustGrantLedgerHome | null)[],
  key: string,
  expectedEntry: CodexTrustEntry
): void {
  for (const ledgerHome of ledgerHomes) {
    const hash = getCodexLedgerTrustedHash(ledgerHome, key, expectedEntry)
    if (hash) {
      hashes.add(hash)
    }
  }
}

type CodexManagedHookTrustOwnershipOptions = {
  runtimeHomePath: string
  sourcePath: string
  command: string
  managedEventLabels: ReadonlySet<CodexEventLabel>
  timeoutSec: number
  /** Explicit native homes resolve their parent before hook discovery. */
  sourceUsesExplicitCodexHome?: boolean
}

function getCodexManagedHookTrustEntryKeys(
  existingEntries: ReadonlyMap<string, CodexHookTrustState>,
  options: CodexManagedHookTrustOwnershipOptions
): string[] {
  const ledgerHome = readCodexTrustGrantLedgerHomeForReconciliation(options.runtimeHomePath)
  const expectedSourcePath = options.sourceUsesExplicitCodexHome
    ? getCodexExplicitHomeHookSourcePath(options.sourcePath)
    : normalizeCodexHookSourcePath(options.sourcePath)
  const ownedKeys: string[] = []
  for (const [key, state] of existingEntries) {
    const parts = parseTrustKey(key)
    if (
      !parts ||
      !codexHookSourcePathsEqual(parts.sourcePath, expectedSourcePath) ||
      !options.managedEventLabels.has(parts.eventLabel)
    ) {
      continue
    }
    const expectedEntry: CodexTrustEntry = {
      sourcePath: expectedSourcePath,
      eventLabel: parts.eventLabel,
      groupIndex: parts.groupIndex,
      handlerIndex: parts.handlerIndex,
      command: options.command,
      timeoutSec: options.timeoutSec
    }
    const recognizedHashes = new Set([
      computeTrustedHash(expectedEntry),
      computeTrustedHash({ ...expectedEntry, timeoutSec: undefined })
    ])
    addLedgerRecognizedHashes(recognizedHashes, [ledgerHome], key, expectedEntry)
    if (state.trustedHash && recognizedHashes.has(state.trustedHash)) {
      ownedKeys.push(key)
    }
  }
  return ownedKeys
}

export function stripCodexManagedHookTrustEntriesFromConfig(
  contents: string,
  options: CodexManagedHookTrustOwnershipOptions
): string {
  const ownedKeys = getCodexManagedHookTrustEntryKeys(
    readHookTrustEntriesFromContent(contents),
    options
  )
  return removeHookTrustEntriesFromContent(contents, ownedKeys)
}

export function removeCodexManagedHookTrustEntries(
  options: CodexManagedHookTrustOwnershipOptions & { tomlPath: string }
): void {
  const ownedKeys = getCodexManagedHookTrustEntryKeys(
    readHookTrustEntries(options.tomlPath),
    options
  )
  if (ownedKeys.length > 0) {
    removeHookTrustEntries(options.tomlPath, ownedKeys)
  }
  // Why: retain the ledger until trust removal succeeds so a later retry can
  // still prove ownership of Codex-computed hashes.
  removeCodexTrustGrantLedgerHome(options.runtimeHomePath)
}

export function removeStaleWslCodexManagedHookTrustEntries(options: {
  tomlPath: string
  runtimeHomePath: string
  desiredEntries: readonly CodexTrustEntry[]
  managedEventLabels: ReadonlySet<CodexEventLabel>
  timeoutSec: number
  buildManagedCommand: (linuxRuntimeHome: string) => string
  priorLedgerHomes?: readonly CodexTrustGrantLedgerHome[]
}): void {
  const desiredKeys = new Set(
    options.desiredEntries.map((entry) => normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
  )
  const ledgerHomes = [
    readCodexTrustGrantLedgerHomeForReconciliation(options.runtimeHomePath),
    ...(options.priorLedgerHomes ?? [])
  ]
  const ownedKeys: string[] = []
  for (const [key, state] of readHookTrustEntries(options.tomlPath)) {
    if (desiredKeys.has(normalizeHookTrustKeyForLookup(key))) {
      continue
    }
    const parts = parseTrustKey(key)
    if (!parts || !options.managedEventLabels.has(parts.eventLabel)) {
      continue
    }
    // Why: this cleanup owns only guest-side WSL trust. A runtime config can
    // still contain user Windows/remote hooks, which must remain untouched.
    if (!parts.sourcePath.startsWith('/') || !parts.sourcePath.endsWith('/hooks.json')) {
      continue
    }
    const linuxRuntimeHome = parts.sourcePath.slice(0, -'/hooks.json'.length)
    const expectedEntry: CodexTrustEntry = {
      sourcePath: parts.sourcePath,
      eventLabel: parts.eventLabel,
      groupIndex: parts.groupIndex,
      handlerIndex: parts.handlerIndex,
      command: options.buildManagedCommand(linuxRuntimeHome),
      timeoutSec: options.timeoutSec
    }
    const recognizedHashes = new Set([
      computeTrustedHash(expectedEntry),
      computeTrustedHash({ ...expectedEntry, timeoutSec: undefined })
    ])
    addLedgerRecognizedHashes(recognizedHashes, ledgerHomes, key, expectedEntry)
    if (state.trustedHash && recognizedHashes.has(state.trustedHash)) {
      ownedKeys.push(key)
    }
  }
  if (ownedKeys.length > 0) {
    removeHookTrustEntries(options.tomlPath, ownedKeys)
  }
}
