import assert from 'node:assert/strict'
import { join } from 'node:path'
import { installInProcessSessionSearchService } from './session-search-in-process-service'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './session-search-indexer-test-fixture'
import { searchSessionService } from './session-search-service-registry'

async function main(): Promise<void> {
  const harness = await openSessionSearchIndexerHarness('bun-search')
  const service = installInProcessSessionSearchService({
    dataRoot: harness.root,
    roots: harness.roots,
    settings: { enabled: false, historyDays: null }
  })
  try {
    assert.ok(service, 'Bun must register a supported search service')
    assert.deepEqual(await searchSessionService({ query: 'bunsearchfixture' }, 'relay'), {
      kind: 'unavailable',
      reason: 'disabled'
    })
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await writeClaudeTranscript(
      join(harness.claudeProjectDir, `${sessionId}.jsonl`),
      ['bunsearchfixture'],
      sessionId
    )
    service.apply({ enabled: true, historyDays: null })
    const result = await searchSessionService(
      { query: 'bunsearchfixture', freshness: 'wait-until-current' },
      'relay'
    )
    assert.equal(result.kind, 'results')
    if (result.kind === 'results') {
      assert.deepEqual(
        result.hits.map((hit) => hit.sessionId),
        [sessionId]
      )
    }
    service.apply({ enabled: false, historyDays: null })
    assert.deepEqual(await searchSessionService({ query: 'bunsearchfixture' }, 'relay'), {
      kind: 'unavailable',
      reason: 'disabled'
    })
    console.log('Bun search registration, indexing, query and consent passed')
  } finally {
    service?.dispose()
    await harness.cleanup()
  }
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
