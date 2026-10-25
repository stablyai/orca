import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_INPUTS_PAGE_MAX_BYTES,
  SIDEBAR_INPUTS_PAGE_MIN_BYTES,
  SIDEBAR_INPUTS_SCHEMA_VERSION,
  SIDEBAR_INPUTS_SEMANTICS_VERSION
} from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import {
  feedEntityFromJson,
  paginateFeedChanges,
  type FeedChange
} from './sidebar-inputs-feed-pages'

const feedEntity = (value: unknown) => feedEntityFromJson(JSON.stringify(value))

// Worst cases for escaping: quotes, backslashes, 3-byte and 4-byte characters.
const NASTY = '"\\é中\u{1f600} '

function encodedPages(changes: FeedChange[], budget: number) {
  return paginateFeedChanges(changes, budget).map((body, index, bodies) =>
    JSON.stringify({
      generation: '00000000-0000-4000-8000-000000000000',
      revision: Number.MAX_SAFE_INTEGER,
      schemaVersion: SIDEBAR_INPUTS_SCHEMA_VERSION,
      semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION,
      kind: 'snapshot',
      from: Number.MAX_SAFE_INTEGER,
      domains: body.domains,
      next: index + 1 < bodies.length ? `${'f'.repeat(36)}.${index + 1}` : null
    })
  )
}

describe('paginateFeedChanges', () => {
  for (const budget of [SIDEBAR_INPUTS_PAGE_MIN_BYTES, SIDEBAR_INPUTS_PAGE_MAX_BYTES]) {
    it(`keeps every encoded page within ${budget} bytes and rejoins oversized entities`, () => {
      const changes: FeedChange[] = [
        ['rows', 'small', feedEntity({ name: NASTY })],
        ['rows', `huge${NASTY}`, feedEntity({ text: NASTY.repeat(budget / 4) })],
        ...Array.from({ length: 500 }, (_, index): FeedChange => [
          index % 2 ? 'rows' : `domain${NASTY}`,
          `key-${index}${NASTY}`,
          index % 7 ? feedEntity({ index, text: NASTY.repeat(index) }) : null
        ])
      ]
      const pages = encodedPages(changes, budget)
      expect(pages.length).toBeGreaterThan(2)
      for (const page of pages) {
        expect(Buffer.byteLength(page, 'utf8')).toBeLessThanOrEqual(budget)
      }
      const joined = pages
        .map((page) => JSON.parse(page).domains.rows?.parts?.[`huge${NASTY}`] ?? '')
        .join('')
      expect(JSON.parse(joined)).toEqual({ text: NASTY.repeat(budget / 4) })
    })
  }

  it('sends one empty page for no changes', () => {
    expect(paginateFeedChanges([], SIDEBAR_INPUTS_PAGE_MAX_BYTES)).toEqual([
      { domains: {}, bytes: 0 }
    ])
  })
})
