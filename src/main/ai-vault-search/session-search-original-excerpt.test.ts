import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultSearchEvidenceSchema } from '../../shared/ai-vault-search-contract'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import {
  selectOriginalExcerpt,
  sessionSearchOriginalExcerpt
} from './session-search-original-excerpt'
import {
  paletteTranscriptLiteralOccurrences,
  preparePaletteTranscriptProofQuery
} from '../../shared/palette-transcript-literal'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import { syntheticCandidate, syntheticSession } from './session-search-index-test-fixture'
import { insertSearchMessage, searchMessageRows } from './session-search-message-rows'
import * as excerpts from './session-search-original-excerpt'

let harness: SessionSearchHarness | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = null
})

it('does not read or scan original messages unless explicitly requested', async () => {
  harness = await openSessionSearchHarness('ss-original-opt-in')
  addSyntheticSession(harness.db, { id: 1, text: 'a needle here' })
  const extraction = vi.spyOn(excerpts, 'sessionSearchOriginalExcerpt')
  for (const includeOriginalExcerpt of [undefined, false]) {
    const result = harness.engine.search({ query: 'needle', includeOriginalExcerpt })
    expect(result.hits[0]?.evidence?.snippet).toContain('[[needle]]')
    expect(result.hits[0]?.evidence).not.toHaveProperty('originalExcerpt')
  }
  expect(extraction).not.toHaveBeenCalled()
  expect(
    harness.engine.search({ query: 'needle', includeOriginalExcerpt: true }).hits[0]?.evidence
      ?.originalExcerpt
  ).toEqual({ text: 'a needle here', startsMessage: false, endsMessage: false })
  expect(extraction).toHaveBeenCalledOnce()
})

it('returns contiguous original context which proves an interior phrase despite legacy ellipses', async () => {
  harness = await openSessionSearchHarness('ss-original-interior')
  const text = `Context ${'padding '.repeat(700)}we fixed the token refresh race today ${'ending '.repeat(180)}`
  addSyntheticSession(harness.db, { id: 1, text })
  const evidence = harness.engine.search({
    query: 'token refresh race',
    includeOriginalExcerpt: true
  }).hits[0]?.evidence
  expect(evidence?.snippet).toContain('…')
  const original = evidence?.originalExcerpt?.text ?? ''
  expect(text).toContain(original)
  expect(Array.from(original)).toHaveLength(512)
  expect(original).toContain('we fixed the token refresh race today')
})

it('prefers compact distinct anchors to an early common word', () => {
  const text = `token ${'padding '.repeat(180)}we fixed token refresh race here ${'padding '.repeat(100)}`
  const original = selectOriginalExcerpt(text, 'token refresh race').text
  expect(original).toContain('we fixed token refresh race here')
  expect(text).toContain(original)
})

it.each([
  ['config', 'The configuration was discussed.', 'The config value was fixed here.'],
  [
    '"token refresh race"',
    'The tokenRefreshRacer was discussed.',
    'We fixed the token refresh race here.'
  ],
  ['config', 'The configurationValue was discussed.', 'The config value was fixed here.'],
  ['café', 'The cafe\u0301teria was discussed.', 'We fixed the cafe\u0301 issue here.'],
  ['refresh', 'The prerefreshpost was discussed.', 'We fixed tokenRefresh here.']
])(
  'selects provable literal context for %s over an earlier partial anchor',
  async (query, impostor, literal) => {
    harness = await openSessionSearchHarness('ss-original-literal')
    const text = `${impostor} ${'padding '.repeat(100)}${literal} ${'context '.repeat(100)}`
    addSyntheticSession(harness.db, { id: 1, text })
    const evidence = harness.engine.search({ query, includeOriginalExcerpt: true }).hits[0]
      ?.evidence
    expect(evidence?.originalExcerpt?.text).toContain(literal)
    const requirements = preparePaletteTranscriptProofQuery(query)
    expect(
      new Set(
        paletteTranscriptLiteralOccurrences(
          evidence?.originalExcerpt?.text ?? '',
          requirements
        ).map((occurrence) => occurrence.group)
      ).size
    ).toBe(requirements.length)
  }
)

it('keeps shadow-only evidence original, including literal marks and ellipses', async () => {
  harness = await openSessionSearchHarness('ss-original-shadow')
  const text = 'look at [[ token_refresh unrelated words race_condition ]] … here'
  addSyntheticSession(harness.db, { id: 1, text })
  const evidence = harness.engine.search({ query: '"refresh race"', includeOriginalExcerpt: true })
    .hits[0]?.evidence
  expect(evidence?.originalExcerpt?.text).toBe(text)
  expect(evidence?.originalExcerpt?.text).not.toContain('refresh race')
})

it('never reads a forbidden tool column or assembles columns', async () => {
  harness = await openSessionSearchHarness('ss-original-scope')
  addSyntheticSession(harness.db, {
    id: 1,
    text: 'look at refresh here',
    toolText: 'we fixed token race here'
  })
  const conversation = harness.engine.search({
    query: 'refresh',
    scope: 'conversation',
    includeOriginalExcerpt: true
  }).hits[0]
  expect(conversation?.evidence?.originalExcerpt?.text).toBe('look at refresh here')
  const all = harness.engine.search({ query: 'refresh token race', includeOriginalExcerpt: true })
    .hits[0]
  expect(all?.evidence?.originalExcerpt?.text).toBe('we fixed token race here')
})

it('bounds Unicode code points and keeps surrogate pairs intact', () => {
  const text = `${'😀'.repeat(200)} a needle here ${'😀'.repeat(400)}`
  const original = selectOriginalExcerpt(text, 'needle').text
  expect(Array.from(original)).toHaveLength(512)
  expect(text).toContain(original)
  expect(
    AiVaultSearchEvidenceSchema.safeParse({
      snippet: '',
      role: 'user',
      timestamp: null,
      originalExcerpt: { text: original }
    }).success
  ).toBe(true)
})

it('bounds context for an indexed-size Unicode message with many literal occurrences', () => {
  const text = '😀 token refresh race '.repeat(350)
  const original = selectOriginalExcerpt(text, 'token refresh race').text
  expect(Array.from(original)).toHaveLength(512)
  expect(text).toContain(original)
  expect(original).toContain('token refresh race')
  expect(original).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
})

it('selects the right original offsets after NFC composition shortens a long prefix', () => {
  const text = `${'e\u0301'.repeat(2500)} before café token refresh race after ${'ending '.repeat(100)}`
  const original = selectOriginalExcerpt(text, 'café token refresh race').text
  expect(text).toContain(original)
  expect(original).toContain('before café token refresh race after')
  expect(Array.from(original).length).toBeLessThanOrEqual(512)
})

it('rechecks retention and the session join at the final indexed read', async () => {
  harness = await openSessionSearchHarness('ss-original-lifetime')
  addSyntheticSession(harness.db, { id: 1, text: 'a needle here' })
  const row = harness.db.prepare('SELECT id FROM messages LIMIT 1').get()
  if (typeof row !== 'object' || !row || !('id' in row) || typeof row.id !== 'number') {
    throw new Error('missing row')
  }
  expect(
    sessionSearchOriginalExcerpt(harness.db, 'all', row.id, 'needle', 1740000000001)
  ).toBeUndefined()
  harness.db.prepare('DELETE FROM sessions WHERE id = 1').run()
  expect(sessionSearchOriginalExcerpt(harness.db, 'all', row.id, 'needle', null)).toBeUndefined()
})

it('keeps legacy evidence usable when optional provenance is absent or malformed', () => {
  const legacy = { snippet: '[[needle]]', role: 'user', timestamp: null }
  expect(AiVaultSearchEvidenceSchema.parse(legacy)).toEqual(legacy)
  for (const originalExcerpt of [
    null,
    { text: 12 },
    { text: 'x'.repeat(513) },
    { text: '\uD800' }
  ]) {
    expect(
      AiVaultSearchEvidenceSchema.parse({ ...legacy, originalExcerpt }).originalExcerpt
    ).toBeUndefined()
  }
})

it('brackets the extra content read with the engine generation check', async () => {
  harness = await openSessionSearchHarness('ss-original-generation')
  const { db, engine } = harness
  addSyntheticSession(db, { id: 1, text: 'a needle here' })
  const prepare = db.prepare.bind(db)
  let changed = false
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (!changed && sql.includes('substr(f.user_text')) {
      changed = true
      prepare(
        "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation'"
      ).run()
    }
    return prepare(sql)
  })
  expect(() => engine.search({ query: 'needle', includeOriginalExcerpt: true })).toThrow(
    'generation'
  )
})

it.each(['refresh', 'refresh at the start', 'at the end refresh'])(
  'proves real message boundaries after production row chunking: %s',
  async (text) => {
    harness = await openSessionSearchHarness('ss-boundaries')
    addSyntheticSession(harness.db, { id: 1, rows: 0 })
    for (const row of searchMessageRows([{ role: 'user', text, timestamp: null }])) {
      insertSearchMessage(harness.db, 1, row)
    }
    const excerpt = harness.engine.search({ query: 'refresh', includeOriginalExcerpt: true })
      .hits[0]?.evidence?.originalExcerpt
    expect(excerpt).toMatchObject({ text, startsMessage: true, endsMessage: true })
    expect(
      paletteTranscriptLiteralOccurrences(excerpt?.text ?? '', ['refresh'], excerpt)
    ).toHaveLength(1)
  }
)

it('rejects artificial chunk and capped-tool boundaries while retaining real source edges', async () => {
  harness = await openSessionSearchHarness('ss-chunk-boundaries')
  const { db, engine } = harness
  for (const [index, text, role] of [
    [1, `${'x'.repeat(8000)}refresh`, 'user'],
    [2, `${'x'.repeat(3064)} refreshSuffix`, 'tool']
  ] as const) {
    const writer = new SessionSearchIndexWriter(db, 1)
    try {
      const path = `boundary-${index}`
      const write = writer.beginWrite(syntheticCandidate({ path }), 'replace', 0)
      if (!write) {
        throw new Error('Expected write')
      }
      write.add({ role, text, timestamp: null })
      expect(
        write.commit({
          session: syntheticSession({ sessionId: String(index), filePath: path }),
          byteOffset: 4096,
          incomplete: false
        })
      ).toBe(true)
    } finally {
      writer.close()
    }
  }
  const hits = engine.search({ query: 'refresh', includeOriginalExcerpt: true }).hits
  expect(hits).toHaveLength(2)
  for (const hit of hits) {
    const excerpt = hit.evidence?.originalExcerpt
    expect(paletteTranscriptLiteralOccurrences(excerpt?.text ?? '', ['refresh'], excerpt)).toEqual(
      []
    )
    expect(excerpt?.startsMessage && excerpt?.endsMessage).toBeFalsy()
  }
})

it('retrieves a version component and proves it in the original conversation text', async () => {
  harness = await openSessionSearchHarness('ss-original-version-component')
  addSyntheticSession(harness.db, {
    id: 1,
    agent: 'codex',
    text: 'Browser annotation "Send" no longer auto-submits to agent (v1.4.217)'
  })
  const result = harness.engine.search({
    query: '217',
    eligibleSessions: { providers: [{ agent: 'codex', sessionId: '1' }], prompts: [] },
    preserveForks: true,
    includeOriginalExcerpt: true
  })
  expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
  const source = result.hits[0]?.evidence?.originalExcerpt
  expect(source?.text).toContain('v1.4.217')
  const ranges = paletteTranscriptLiteralOccurrences(
    source?.text ?? '',
    preparePaletteTranscriptProofQuery('217'),
    source
  )
  expect(ranges.map((range) => source?.text.slice(range.start, range.end))).toEqual(['217'])
})
