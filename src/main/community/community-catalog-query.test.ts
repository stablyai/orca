import { expect, test } from 'vitest'
import type {
  CommunityCatalog,
  CommunityPullRequest,
  CommunitySyncStatus
} from '../../shared/community-catalog'
import type { CommunityFeaturesSnapshot } from '../../shared/community-features'
import { communityQueryNumber, queryCommunityCatalog } from './community-catalog-query'

const row = (number: number, author: string): CommunityPullRequest => ({
  number,
  author,
  title: 'Image gallery',
  displayTitle: 'Image gallery',
  url: `https://github.com/stablyai/orca/pull/${number}`,
  createdAt: '2026-11-13T10:00:00Z',
  updatedAt: '2026-11-13T10:00:00Z',
  isDraft: false,
  kind: 'Features',
  area: 'Chat',
  comments: null,
  prThumbsUp: null,
  closingIssues: [],
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  reviewDecision: null,
  checkState: null,
  checkObserved: false,
  additions: null,
  deletions: null,
  changedFiles: null,
  imageUrls: [],
  state: 'open'
})
const catalog: CommunityCatalog = {
  repository: 'stablyai/orca',
  capturedAt: '2026-11-13T10:00:00Z',
  sourceUrl: 'https://github.com/stablyai/orca/pulls',
  pullRequests: [row(41731, 'Vegas97'), row(4173, 'another'), row(141731, 'VEGAS97')],
  groups: [],
  screenshots: {}
}
const personal: CommunityFeaturesSnapshot = { revision: 1, features: {} }
const status: CommunitySyncStatus = {
  running: false,
  pages: 0,
  received: 0,
  error: null,
  retryAt: null
}

test('My PRs uses the selected account with exact case-insensitive author matching', () => {
  const page = queryCommunityCatalog(catalog, personal, status, { mine: true }, 'vegas97')
  expect(page.rows.map((entry) => entry.number)).toEqual([41731, 141731])
  expect(page.viewer).toBe('vegas97')
  expect(
    queryCommunityCatalog(catalog, personal, status, { mine: true }, 'another').rows.map(
      (entry) => entry.number
    )
  ).toEqual([4173])
  expect(queryCommunityCatalog(catalog, personal, status, { mine: true }).rows).toEqual([])
})

test('PR numbers and same-repository links match exactly rather than as substrings', () => {
  for (const query of [
    '41731',
    '#41731',
    'PR #41731',
    'pr:41731',
    'https://github.com/stablyai/orca/pull/41731'
  ]) {
    expect(
      queryCommunityCatalog(catalog, personal, status, { query }).rows.map((entry) => entry.number)
    ).toEqual([41731])
  }
  expect(communityQueryNumber('https://github.com/another/orca/pull/41731')).toBeNull()
  expect(communityQueryNumber('#2147483648')).toBeNull()
})

test('My PRs composes with saved state, search, and pagination', () => {
  const saved: CommunityFeaturesSnapshot = {
    revision: 1,
    features: {
      41731: {
        number: 41731,
        savedAt: '2026-11-13T10:00:00Z',
        selectedAt: '2026-11-13T10:00:00Z',
        visit: null,
        chat: null,
        source: null,
        signals: null,
        installed: null,
        candidate: null,
        evidenceId: null,
        release: null
      }
    }
  }
  expect(
    queryCommunityCatalog(
      catalog,
      saved,
      status,
      { mine: true, view: 'saved' },
      'Vegas97'
    ).rows.map((entry) => entry.number)
  ).toEqual([41731])
  expect(
    queryCommunityCatalog(catalog, saved, status, { inclusion: 'selected' }).rows.map(
      (row) => row.number
    )
  ).toEqual([41731])
  const page = queryCommunityCatalog(
    catalog,
    personal,
    status,
    { mine: true, query: 'image gallery', limit: 1 },
    'Vegas97'
  )
  expect(page.total).toBe(2)
  expect(page.rows.map((entry) => entry.number)).toEqual([41731])
  expect(page.nextOffset).toBe(1)
})

test('search finds description text and installed feature names with build and review filters', () => {
  const build = {
    id: 'custom',
    baseVersion: '1.4.257',
    profileMode: 'interactive-preview' as const,
    changes: [
      {
        id: 'gallery',
        title: 'Chat image gallery',
        description: 'Scrollable thumbnails.',
        pullRequest: {
          number: 41731,
          headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          url: 'https://github.com/stablyai/orca/pull/41731'
        }
      }
    ]
  }
  const source = {
    ...catalog,
    pullRequests: [
      { ...row(41731, 'Vegas97'), title: 'Community manager', displayTitle: 'Community manager' },
      {
        ...row(4173, 'Vegas97'),
        title: 'Other change',
        description: 'A searchable description about pictures.',
        isDraft: true
      }
    ]
  }
  expect(
    queryCommunityCatalog(
      source,
      personal,
      status,
      { query: 'image gallery', inclusion: 'installed', mine: true },
      'Vegas97',
      build
    ).rows.map((r) => r.number)
  ).toEqual([41731])
  expect(
    queryCommunityCatalog(source, personal, status, { inclusion: 'installed' }, 'Vegas97', null)
      .rows
  ).toEqual([])
  expect(
    queryCommunityCatalog(
      source,
      personal,
      status,
      { query: 'pictures', readiness: 'draft' },
      'Vegas97',
      build
    ).rows.map((r) => r.number)
  ).toEqual([4173])
  expect(
    queryCommunityCatalog(
      source,
      personal,
      status,
      { readiness: 'ready', mine: true },
      'Vegas97',
      build
    ).rows.map((r) => r.number)
  ).toEqual([41731])
})
