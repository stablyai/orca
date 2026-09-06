import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  clearAiVaultSearchIndex,
  installAiVaultSearchSettingsSource
} from './session-search-enablement'
import { initSessionSearchPaths, resetSessionSearchPathsForTests } from './session-search-paths'
import { resetSessionSearchPolicyForTests } from './session-search-policy'
vi.mock('../ai-vault/cached-session-list', () => ({
  configureAiVaultSearch: async (init: never, options: { clearIndex?: boolean }) => {
    const { configureAiVaultSearchInWorker } =
      await import('../ai-vault/session-scanner-worker-spawn')
    return configureAiVaultSearchInWorker({ init, roots: {}, clearIndex: options.clearIndex })
  }
}))
it('clears persisted index before a scanner has been started', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-clear-audit-'))
  try {
    const dir = join(root, 'ai-vault-search')
    await mkdir(dir)
    const path = join(dir, 'index.sqlite')
    await writeFile(path, 'synthetic index')
    await writeFile(`${path}-wal`, 'synthetic WAL')
    initSessionSearchPaths(root)
    installAiVaultSearchSettingsSource(() => ({
      aiVaultSearch: { enabled: false, historyDays: null }
    }))
    await clearAiVaultSearchIndex()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}-wal`)).toBe(false)
  } finally {
    resetSessionSearchPathsForTests()
    resetSessionSearchPolicyForTests()
    await rm(root, { recursive: true, force: true })
  }
})
