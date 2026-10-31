import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  normalizeHookTrustKeyForLookup,
  normalizeCodexHookSourcePath,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
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
import type { CodexHookHashes } from './codex-hook-trust-derivation'

export function readCodexTrustGrantLedgerHomeForReconciliation(
  runtimeHomePath: string
): CodexTrustGrantLedgerHome | null {
  try {
    return readCodexTrustGrantLedgerHome(runtimeHomePath)
  } catch {
    return null
  }
}

function getCodexLedgerTrustedHash(
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

/** Read Codex's recorded hashes only for matching Orca hook signatures. */
export function readLedgerOrcaHashes(
  runtimeHomePath: string,
  command: string,
  timeoutSec: number
): CodexHookHashes[] {
  const ledgerHome = readCodexTrustGrantLedgerHomeForReconciliation(runtimeHomePath)
  return Object.keys(ledgerHome?.entries ?? {}).flatMap((key) => {
    const parts = parseTrustKey(key)
    if (!parts) {
      return []
    }
    const hashes = new Set<string>()
    addLedgerRecognizedHashes(hashes, [ledgerHome], key, { ...parts, command, timeoutSec })
    return [...hashes].map((hash) => ({ [parts.eventLabel]: hash }))
  })
}

type CodexManagedHookTrustOwnershipOptions = {
  runtimeHomePath: string
  /** Primary hooks.json path first, followed by equivalent trust-key spellings. */
  sourcePaths: readonly [string, ...string[]]
  command: string
  managedEventLabels: ReadonlySet<CodexEventLabel>
  timeoutSec: number
  /** Explicit native homes resolve their parent before hook discovery. */
  sourceUsesExplicitCodexHome?: boolean
  /** Include prior Codex versions' hashes to recognize older approvals. */
  codexHashes?: readonly CodexHookHashes[]
}

function getCodexManagedHookTrustEntryKeys(
  existingEntries: ReadonlyMap<string, CodexHookTrustState>,
  options: CodexManagedHookTrustOwnershipOptions
): string[] {
  const ledgerHome = readCodexTrustGrantLedgerHomeForReconciliation(options.runtimeHomePath)
  const [sourcePath, ...aliases] = options.sourcePaths
  const expectedSourcePath = options.sourceUsesExplicitCodexHome
    ? getCodexExplicitHomeHookSourcePath(sourcePath)
    : normalizeCodexHookSourcePath(sourcePath)
  const aliasSourcePaths = aliases.map(normalizeCodexHookSourcePath)
  const ownedKeys: string[] = []
  for (const [key, state] of existingEntries) {
    const parts = parseTrustKey(key)
    if (!parts || !options.managedEventLabels.has(parts.eventLabel)) {
      continue
    }
    const isAlias = aliasSourcePaths.some((alias) =>
      codexHookSourcePathsEqual(parts.sourcePath, alias)
    )
    if (!isAlias && !codexHookSourcePathsEqual(parts.sourcePath, expectedSourcePath)) {
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
    if (isAlias) {
      // The ledger records grants under the primary path spelling only.
      addLedgerRecognizedHashes(
        recognizedHashes,
        [ledgerHome],
        computeTrustKey(expectedEntry),
        expectedEntry
      )
    }
    for (const hashes of options.codexHashes ?? []) {
      const codexHash = hashes[parts.eventLabel]
      if (codexHash) {
        recognizedHashes.add(codexHash)
      }
    }
    if (state.trustedHash && recognizedHashes.has(state.trustedHash)) {
      ownedKeys.push(key)
    }
  }
  return ownedKeys
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
  // Keep ownership proof until trust removal succeeds, allowing safe retries.
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
    // Only guest-side WSL trust is owned here; preserve user Windows/remote hooks.
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
