import './worker/session-search-worker.test-fixture'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import type { AiVaultSearchSettings } from '../../shared/ai-vault/search/ai-vault-search-settings'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './indexing/session-search-indexer-test-fixture'
import { assistantRecord, userRecord } from './indexing/session-search-transcript-fixtures'
import type { SessionSearchScopeStore } from './scope/session-search-store-scope-catalog'
import { searchSessionService } from './session-search-service-registry'
import { resetSessionSearchPolicyForTests } from './session-search-policy'
import { resetSessionSearchServiceInitForTests } from './session-search-service-init'

const localAiVaultScanRoots = vi.hoisted(() => vi.fn())
vi.mock('../ai-vault/discovery/ai-vault-scan-roots', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localAiVaultScanRoots
}))

let harness: SessionSearchIndexerHarness
let installed: { apply?(settings: AiVaultSearchSettings): void; dispose(): void } | null

const scopeStore: SessionSearchScopeStore = {
  getRepos: () => [{ id: 'repo-app', path: '/repo/app', kind: 'git' }],
  getProjects: () => [],
  getProjectHostSetups: () => [],
  getAllWorktreeMeta: () => ({}),
  getSettings: () => ({ workspaceDir: '/workspaces', nestWorkspaces: false })
}

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-registration')
  installed = null
  localAiVaultScanRoots.mockReset().mockResolvedValue(harness.roots)
})

afterEach(async () => {
  installed?.dispose()
  const { setSessionSearchService } = await import('./session-search-service-registry')
  setSessionSearchService(null)
  resetSessionSearchPolicyForTests()
  resetSessionSearchServiceInitForTests()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

it('orcad resolves no roots while disabled and discovers late roots when enabled', async () => {
  const { installOrcadSessionSearchService } =
    await import('../orcad/host-runtime/orcad-session-search')
  installed = await installOrcadSessionSearchService({
    userDataPath: harness.root,
    getSettings: () => ({ aiVaultSearch: { enabled: false, historyDays: null } }),
    scopeStore
  })
  expect(localAiVaultScanRoots).not.toHaveBeenCalled()
  installed?.dispose()
  installed = await installOrcadSessionSearchService({
    userDataPath: harness.root,
    getSettings: () => ({ aiVaultSearch: { enabled: true, historyDays: null } }),
    scopeStore
  })
  await searchSessionService({ query: 'latehostroot', freshness: 'wait-until-current' }, 'ipc')
  const late = join(harness.root, 'late-claude')
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await writeClaudeTranscript(join(late, 'project', `${id}.jsonl`), ['latehostroot'], id)
  localAiVaultScanRoots.mockResolvedValue({ ...harness.roots, claudeProjectsDir: late })
  const response = await searchSessionService(
    { query: 'latehostroot', freshness: 'wait-until-current' },
    'ipc'
  )
  expect(response.kind).toBe('results')
  if (response.kind === 'results') {
    expect(response.hits.map((hit) => hit.sessionId)).toEqual([id])
  }
})

it('orcad answers a workspace-scoped search from its own repos', async () => {
  const inside = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001'
  const outside = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002'
  for (const [id, cwd] of [
    [inside, '/repo/app'],
    [outside, '/repo/other']
  ]) {
    await mkdir(harness.claudeProjectDir, { recursive: true })
    await writeFile(
      join(harness.claudeProjectDir, `${id}.jsonl`),
      `${userRecord(0, 'scopedneedle', id, cwd)}\n${assistantRecord(1, 'ok', id)}\n`
    )
  }
  const { installOrcadSessionSearchService } =
    await import('../orcad/host-runtime/orcad-session-search')
  installed = await installOrcadSessionSearchService({
    userDataPath: harness.root,
    getSettings: () => ({ aiVaultSearch: { enabled: true, historyDays: null } }),
    scopeStore
  })
  const response = await searchSessionService(
    {
      query: 'scopedneedle',
      freshness: 'wait-until-current',
      within: { kind: 'workspace', worktreeId: 'repo-app::/repo/app' }
    },
    'ipc'
  )
  expect(response.kind).toBe('results')
  if (response.kind === 'results') {
    expect(response.hits.map((hit) => hit.sessionId)).toEqual([inside])
  }
})
