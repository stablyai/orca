import { vi } from 'vitest'
import { computeOrcaCodexHookHashes } from './codex-hook-definition'
import type * as TrustDerivation from './codex-hook-trust-derivation'

export const CODEX_VERSION_FOR_TESTS = 'codex-cli 0.150.1'

/**
 * A Codex on PATH that answers with Orca's own hashes, spawning nothing. Use as
 * `vi.mock('./codex-hook-trust-derivation', async (importOriginal) =>
 * (await import('./codex-hook-trust-derivation.test-fixture')).answeringCodexForTests(await importOriginal()))`.
 */
export function answeringCodexForTests(actual: typeof TrustDerivation): typeof TrustDerivation {
  return {
    ...actual,
    fingerprintCodex: vi.fn(() => 'codex-for-tests'),
    probeCodexVersion: vi.fn(async () => CODEX_VERSION_FOR_TESTS),
    deriveCodexHookHashes: vi.fn(
      async (_codexPath: string, command: string, codexVersion: string) => ({
        kind: 'hashes' as const,
        codexVersion,
        hashes: computeOrcaCodexHookHashes(command)
      })
    )
  }
}
