import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TrustConfigFixture = {
  tmpDir: string
  configPath: string
}

/** Throwaway home for a Codex `config.toml` trust test. */
export function createTrustConfigFixture(): TrustConfigFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'orca-codex-trust-test-'))
  return { tmpDir, configPath: join(tmpDir, 'config.toml') }
}

export function removeTrustConfigFixture(tmpDir: string): void {
  rmSync(tmpDir, { recursive: true, force: true })
}
