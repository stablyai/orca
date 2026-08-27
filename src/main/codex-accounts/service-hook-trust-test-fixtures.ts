import { join } from 'node:path'
import { testState } from './service-test-harness'

export type CanonicalHookTrustFixture = {
  config: string
  orcaKeys: string[]
  userKey: string
}

export async function createCanonicalHookTrustFixture(): Promise<CanonicalHookTrustFixture> {
  const { MANAGED_HOOK_TIMEOUT_SECONDS } = await import('../agent-hooks/installer-utils')
  const { getCodexManagedHookInstallMaterial } = await import('../codex/hook-service')
  const { computeTrustKey, computeTrustedHash, escapeTomlString, normalizeHookTrustKeyForLookup } =
    await import('../codex/config-toml-trust')
  const { getCodexHookTrustSignature } = await import('../codex/codex-hook-identity')
  const { writeCodexTrustGrantLedgerHome } = await import('../codex/codex-trust-grant-ledger')
  const sourceHomePath = join(testState.fakeHomeDir, '.codex')
  const sourcePath = join(sourceHomePath, 'hooks.json')
  const material = getCodexManagedHookInstallMaterial()
  const expectedHashEntry = {
    sourcePath,
    eventLabel: 'stop' as const,
    groupIndex: 0,
    handlerIndex: 0,
    command: material.command,
    timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
  }
  const ledgerHashEntry = {
    ...expectedHashEntry,
    eventLabel: 'session_start' as const,
    groupIndex: 1
  }
  const userEntry = {
    ...expectedHashEntry,
    groupIndex: 2,
    command: 'user-authored-hook'
  }
  const expectedHashKey = computeTrustKey(expectedHashEntry)
  const ledgerHashKey = computeTrustKey(ledgerHashEntry)
  const userKey = computeTrustKey(userEntry)
  const ledgerTrustedHash = 'sha256:codex-granted-orca-hook'
  writeCodexTrustGrantLedgerHome(sourceHomePath, {
    binary: null,
    entries: {
      [normalizeHookTrustKeyForLookup(ledgerHashKey)]: {
        signature: getCodexHookTrustSignature(ledgerHashEntry),
        trustedHash: ledgerTrustedHash
      }
    }
  })
  const block = (key: string, trustedHash: string): string =>
    `[hooks.state."${escapeTomlString(key)}"]\ntrusted_hash = "${trustedHash}"\nenabled = true`
  return {
    config: [
      'approval_policy = "never"',
      block(expectedHashKey, computeTrustedHash(expectedHashEntry)),
      block(ledgerHashKey, ledgerTrustedHash),
      block(userKey, computeTrustedHash(userEntry))
    ].join('\n\n'),
    orcaKeys: [expectedHashKey, ledgerHashKey],
    userKey
  }
}
