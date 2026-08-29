import { createHash } from 'node:crypto'
import type { CodexAppServerHostKey } from './codex-app-server-capability-cache'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import {
  getCodexTrustGrantHomeKey,
  type CodexTrustGrantBinaryStamp
} from './codex-trust-grant-ledger'
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

export function getMirroredRuntimeTrustScopeKey(
  hostKey: CodexAppServerHostKey,
  runtimeHomePath: string
): string {
  return `${hostKey}\0${getCodexTrustGrantHomeKey(runtimeHomePath)}`
}

export function getMirroredRuntimeTrustFingerprint(
  args: {
    entries: readonly CodexTrustEntry[]
    systemEntries: readonly CodexTrustEntry[]
    tomlPath: string
  },
  binaryStamp: CodexTrustGrantBinaryStamp | null
): string {
  const actual = readHookTrustEntries(args.tomlPath)
  const entries = args.entries
    .map((entry) => {
      const key = normalizeHookTrustKeyForLookup(computeTrustKey(entry))
      return {
        key,
        signature: getCodexHookTrustSignature(entry),
        approvedHash: entry.trustedHash ?? null,
        enabled: entry.enabled !== false,
        actual: actual.get(key) ?? null
      }
    })
    .sort((left, right) => left.key.localeCompare(right.key))
  const systemApprovals = args.systemEntries.map((entry) => ({
    key: normalizeHookTrustKeyForLookup(computeTrustKey(entry)),
    signature: getCodexHookTrustSignature(entry),
    approvedHash: entry.trustedHash ?? null
  }))
  return createHash('sha256')
    .update(JSON.stringify({ binaryStamp, entries, systemApprovals }))
    .digest('hex')
}
