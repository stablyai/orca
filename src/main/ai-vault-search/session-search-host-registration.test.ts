import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import type { AiVaultSearchSettings } from '../../shared/ai-vault/search/ai-vault-search-settings'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { searchSessionService } from './session-search-service-registry'
import { resetSessionSearchPolicyForTests } from './session-search-policy'
import { resetSessionSearchServiceInitForTests } from './session-search-service-init'

const localAiVaultScanRoots = vi.hoisted(() => vi.fn())
vi.mock('../ai-vault/cached-session-list', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localAiVaultScanRoots
}))

let harness: SessionSearchIndexerHarness
let installed: { apply?(settings: AiVaultSearchSettings): void; dispose(): void } | null

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
  const { installOrcadSessionSearchService } = await import('../orcad/orcad-session-search')
  installed = await installOrcadSessionSearchService({
    userDataPath: harness.root,
    getSettings: () => ({ aiVaultSearch: { enabled: false, historyDays: null } })
  })
  expect(localAiVaultScanRoots).not.toHaveBeenCalled()
  installed?.dispose()
  installed = await installOrcadSessionSearchService({
    userDataPath: harness.root,
    getSettings: () => ({ aiVaultSearch: { enabled: true, historyDays: null } })
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
