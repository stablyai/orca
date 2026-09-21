import { describe, expect, it } from 'vitest'
import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import {
  buildClientPageAdoptionIntents,
  selectAdoptableClientHostedPages,
  type AdoptableClientHostedPage
} from './browser-host-client-page-adoption'

const CURRENT_RUNTIME_ID = 'runtime-new'
const PREDECESSOR_RUNTIME_ID = 'runtime-old'
const HOST_CLIENT_ID = 'client-a'

const page = (
  overrides: Partial<BrowserClientHostedPageInventory> = {}
): BrowserClientHostedPageInventory => ({
  authorityRuntimeId: PREDECESSOR_RUNTIME_ID,
  authorityEpoch: 'epoch-old',
  browserHostClientId: HOST_CLIENT_ID,
  browserHostGeneration: 3,
  browserPageId: 'page-a',
  pageHostGeneration: 4,
  browserProfileId: 'profile-a',
  executionHostKey: `native:${PREDECESSOR_RUNTIME_ID}:1`,
  state: 'active',
  currentUrl: 'https://remote.example/current',
  workspaceId: 'workspace-a',
  ...overrides
})

const candidacy = (inventory: readonly BrowserClientHostedPageInventory[]) => ({
  inventory,
  browserHostClientId: HOST_CLIENT_ID,
  authorityRuntimeId: CURRENT_RUNTIME_ID,
  hasRuntimePage: () => false
})

const adoptable = (overrides: Partial<BrowserClientHostedPageInventory> = {}) =>
  page(overrides) as AdoptableClientHostedPage

const authority = { authorityRuntimeId: CURRENT_RUNTIME_ID, authorityEpoch: 'epoch-new' }

const lease = {
  browserHostClientId: HOST_CLIENT_ID,
  browserHostGeneration: 9,
  pairedDeviceId: 'device-a'
}

describe('selectAdoptableClientHostedPages', () => {
  it('adopts an active page a predecessor runtime placed on this host', () => {
    const candidate = page()

    expect(selectAdoptableClientHostedPages(candidacy([candidate]))).toEqual([candidate])
  })

  it('rejects a page whose guest outcome is unknown', () => {
    const candidate = page({ state: 'outcomeUnknown' })

    expect(selectAdoptableClientHostedPages(candidacy([candidate]))).toEqual([])
  })

  it('rejects a page with no workspaceId because the runtime record cannot be rebuilt', () => {
    const candidate = page({ workspaceId: undefined })

    expect(selectAdoptableClientHostedPages(candidacy([candidate]))).toEqual([])
  })

  it('rejects a page placed on a different browser host client', () => {
    const candidate = page({ browserHostClientId: 'client-b' })

    expect(selectAdoptableClientHostedPages(candidacy([candidate]))).toEqual([])
  })

  it('rejects a page naming this runtime as authority because this process closed it deliberately', () => {
    const candidate = page({ authorityRuntimeId: CURRENT_RUNTIME_ID })

    expect(selectAdoptableClientHostedPages(candidacy([candidate]))).toEqual([])
  })

  it('rejects a page the runtime already tracks', () => {
    const candidate = page()

    expect(
      selectAdoptableClientHostedPages({
        ...candidacy([candidate]),
        hasRuntimePage: (browserPageId) => browserPageId === candidate.browserPageId
      })
    ).toEqual([])
  })

  it('returns only the qualifying entries of a mixed inventory', () => {
    const adoptableA = page({ browserPageId: 'page-adoptable-a' })
    const adoptableB = page({ browserPageId: 'page-adoptable-b' })
    const tracked = page({ browserPageId: 'page-tracked' })
    const rejected = [
      page({ browserPageId: 'page-dead', state: 'outcomeUnknown' }),
      page({ browserPageId: 'page-no-workspace', workspaceId: undefined }),
      page({ browserPageId: 'page-other-client', browserHostClientId: 'client-b' }),
      page({ browserPageId: 'page-ours', authorityRuntimeId: CURRENT_RUNTIME_ID }),
      tracked
    ]

    const selected = selectAdoptableClientHostedPages({
      ...candidacy([adoptableA, ...rejected, adoptableB]),
      hasRuntimePage: (browserPageId) => browserPageId === tracked.browserPageId
    })

    expect(selected).toEqual([adoptableA, adoptableB])
  })
})

describe('buildClientPageAdoptionIntents', () => {
  const executionHostKeyByWorkspaceId = new Map([['workspace-a', `native:${CURRENT_RUNTIME_ID}:1`]])

  it('stamps the current runtime authority and the attaching lease, not the inventory values', () => {
    const candidate = adoptable()

    const [intent] = buildClientPageAdoptionIntents({
      pages: [candidate],
      authority,
      lease,
      executionHostKeyByWorkspaceId
    })

    expect(intent).toMatchObject({
      authorityRuntimeId: CURRENT_RUNTIME_ID,
      authorityEpoch: 'epoch-new',
      browserHostClientId: HOST_CLIENT_ID,
      browserHostGeneration: lease.browserHostGeneration
    })
    expect(intent?.authorityRuntimeId).not.toBe(candidate.authorityRuntimeId)
    expect(intent?.authorityEpoch).not.toBe(candidate.authorityEpoch)
    expect(intent?.browserHostGeneration).not.toBe(candidate.browserHostGeneration)
  })

  it('carries the workspace and profile through from the inventory entry', () => {
    const candidate = adoptable({ browserProfileId: 'profile-z', browserPageId: 'page-z' })

    const [intent] = buildClientPageAdoptionIntents({
      pages: [candidate],
      authority,
      lease,
      executionHostKeyByWorkspaceId
    })

    expect(intent).toMatchObject({
      workspaceId: 'workspace-a',
      browserProfileId: 'profile-z',
      browserPageId: 'page-z'
    })
  })

  it("uses the workspace's current execution host key rather than the inventory's dead route", () => {
    const candidate = adoptable()

    const [intent] = buildClientPageAdoptionIntents({
      pages: [candidate],
      authority,
      lease,
      executionHostKeyByWorkspaceId
    })

    expect(intent?.executionHostKey).toBe(`native:${CURRENT_RUNTIME_ID}:1`)
    // native/wsl keys embed the runtime id, so the inventory's key names the dead predecessor.
    expect(intent?.executionHostKey).not.toBe(candidate.executionHostKey)
  })

  it('drops a page whose workspace has no current execution host key', () => {
    const resolvable = adoptable({ browserPageId: 'page-resolvable' })
    const orphaned = adoptable({ browserPageId: 'page-orphaned', workspaceId: 'workspace-gone' })

    const intents = buildClientPageAdoptionIntents({
      pages: [resolvable, orphaned],
      authority,
      lease,
      executionHostKeyByWorkspaceId
    })

    expect(intents.map((intent) => intent.browserPageId)).toEqual(['page-resolvable'])
  })

  it('emits no reclaimFrom because reclaim requires an unchanged execution host key', () => {
    const [intent] = buildClientPageAdoptionIntents({
      pages: [adoptable()],
      authority,
      lease,
      executionHostKeyByWorkspaceId
    })

    // A restart rekeys the network route, so the guest must be closed and restored, never reclaimed.
    expect(intent?.reclaimFrom).toBeUndefined()
  })

  const unsortedPages = [
    adoptable({ browserPageId: 'page-2', pageHostGeneration: 2 }),
    adoptable({ browserPageId: 'page-7', pageHostGeneration: 7 }),
    adoptable({ browserPageId: 'page-5', pageHostGeneration: 5 })
  ]

  it('assigns distinct generations above every generation the inventory reports', () => {
    const intents = buildClientPageAdoptionIntents({
      pages: unsortedPages,
      authority,
      lease,
      executionHostKeyByWorkspaceId
    })

    const highestReported = Math.max(...unsortedPages.map((entry) => entry.pageHostGeneration))
    const assigned = intents.map((intent) => intent.pageHostGeneration)

    expect(assigned).toHaveLength(unsortedPages.length)
    expect(new Set(assigned).size).toBe(assigned.length)
    for (const generation of assigned) {
      expect(generation).toBeGreaterThan(highestReported)
    }
  })

  it('assigns generations in ascending order of the pages own generations', () => {
    const intents = buildClientPageAdoptionIntents({
      pages: unsortedPages,
      authority,
      lease,
      executionHostKeyByWorkspaceId
    })

    expect(intents.map((intent) => [intent.browserPageId, intent.pageHostGeneration])).toEqual([
      ['page-2', 8],
      ['page-5', 9],
      ['page-7', 10]
    ])
  })
})
