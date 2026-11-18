import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as DistroCatalog from '../../wsl/discovery/distro-catalog'
import { mkdtemp, realpath, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { verifiedWorkspaceConversation } from './workspace-conversation-source'
import {
  configureAiVaultSessionSources,
  localAiVaultSessionRootDirs,
  resetAiVaultSessionSourcesForTests
} from '../../ai-vault/discovery/ai-vault-scan-roots'
import { AI_VAULT_AGENT_SOURCES } from '../../ai-vault/discovery/session-scanner-agent-sources'
import { discoverFiles } from '../../ai-vault/discovery/session-scanner-discovery'
import { ClaudeObservedConfigDirs } from '../../claude-accounts/profiles/routing/claude-observed-config-dirs'
import { installClaudeObservedConfigDirs } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'

vi.mock('../../wsl/discovery/distro-catalog', async (original) => ({
  ...(await original<typeof DistroCatalog>()),
  hasCachedWslDistros: () => true,
  getCachedWslDistros: () => []
}))

const sessionId = '00000000-0000-4000-8000-000000000002'
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-history-resume-')))
  vi.stubEnv('CODEX_HOME', join(root, 'default-home'))
})
afterEach(async () => {
  resetAiVaultSessionSourcesForTests()
  installClaudeObservedConfigDirs(undefined)
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it.each(['codex', 'claude'] as const)(
  'resumes a %s conversation discovered outside the account roster',
  async (provider) => {
    const workspace = join(root, 'workspace')
    const sourceHome = join(root, 'external-home')
    const targetHome = join(root, 'workspace-account')
    const historyRoot = join(sourceHome, provider === 'codex' ? 'sessions' : 'projects')
    const filePath =
      provider === 'codex'
        ? join(historyRoot, '2026', '11', '17', `rollout-2026-11-17T10-00-00-${sessionId}.jsonl`)
        : join(historyRoot, '-workspace', `${sessionId}.jsonl`)
    await Promise.all(
      [workspace, targetHome, dirname(filePath)].map((dir) => mkdir(dir, { recursive: true }))
    )
    await writeFile(
      filePath,
      `${JSON.stringify(
        provider === 'codex'
          ? { type: 'session_meta', payload: { id: sessionId, cwd: workspace } }
          : {
              type: 'user',
              sessionId,
              cwd: workspace,
              message: { role: 'user', content: 'A discovered conversation' }
            }
      )}\n`
    )
    if (provider === 'codex') {
      configureAiVaultSessionSources({ getAdditionalCodexHomePaths: () => [sourceHome] })
    } else {
      const observed = new ClaudeObservedConfigDirs(join(root, 'observed.json'), () => ({}))
      observed.observeTranscriptPath(filePath)
      installClaudeObservedConfigDirs(observed)
    }
    const roots = await localAiVaultSessionRootDirs(provider)
    const discovery = await discoverFiles({
      ...AI_VAULT_AGENT_SOURCES[provider],
      extensions: ['.jsonl'],
      agent: provider,
      rootDir: roots.find((entry) => entry === historyRoot)!,
      limit: 10,
      issues: []
    })
    const discovered = discovery.files.find((file) => file.path === filePath)
    expect(discovered?.path).toBe(filePath)
    const source = await verifiedWorkspaceConversation({
      provider,
      sessionId,
      filePath: discovered!.path,
      roots: await localAiVaultSessionRootDirs(provider)
    })
    expect(source).toMatchObject({ sourceHome, filePath, cwd: workspace })
  }
)
