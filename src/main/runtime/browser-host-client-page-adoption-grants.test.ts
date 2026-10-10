import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import { adoptBrowserHostClientPages } from './browser-host-client-page-adoption'
import type { BrowserClientPageExecutionHostGrant } from './browser-host-client-page-creation'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'

const HOST_CLIENT_ID = 'client-a'
const HOST_GENERATION = 9

const intent = (
  overrides: Partial<BrowserHostRuntimePageIntent> = {}
): BrowserHostRuntimePageIntent => ({
  authorityRuntimeId: 'runtime-new',
  authorityEpoch: 'epoch-new',
  browserHostClientId: HOST_CLIENT_ID,
  browserHostGeneration: HOST_GENERATION,
  pageHostGeneration: 11,
  browserPageId: 'page-a',
  browserProfileId: 'profile-a',
  executionHostKey: 'native:runtime-new:1',
  workspaceId: 'workspace-a',
  ...overrides
})

const clientPlacement = (pageHostGeneration: number): RuntimeBrowserPlacement => ({
  kind: 'client',
  browserHostClientId: HOST_CLIENT_ID,
  browserHostGeneration: HOST_GENERATION,
  pageHostGeneration
})

const serverPlacement: RuntimeBrowserPlacement = { kind: 'server' }

function harness(options: {
  placements: Record<string, RuntimeBrowserPlacement | undefined>
  adopt?: () => Promise<unknown>
  existingGrants?: Map<string, BrowserClientPageExecutionHostGrant>
}) {
  const releases: { executionHostKey: string; release: ReturnType<typeof vi.fn> }[] = []
  const retain = vi.fn((executionHostKey: string) => {
    const release = vi.fn()
    releases.push({ executionHostKey, release })
    return { release }
  })
  const adopt = vi.fn(options.adopt ?? (() => Promise.resolve(undefined)))
  const getPlacement = vi.fn((browserPageId: string) => options.placements[browserPageId])
  const executionHostGrants =
    options.existingGrants ?? new Map<string, BrowserClientPageExecutionHostGrant>()
  const state = { executionHostGrants: { retain } } as unknown as BrowserHostLeaseState

  return {
    retain,
    adopt,
    getPlacement,
    executionHostGrants,
    releases,
    dependencies: {
      state,
      reconciliations: { adopt },
      placements: { getPlacement },
      executionHostGrants
    }
  }
}

describe('adoptBrowserHostClientPages', () => {
  it('returns the pages whose committed placement matches the intent and stores their grants', async () => {
    const first = intent({ browserPageId: 'page-a', pageHostGeneration: 11 })
    const second = intent({ browserPageId: 'page-b', pageHostGeneration: 12 })
    const fake = harness({
      placements: { 'page-a': clientPlacement(11), 'page-b': clientPlacement(12) }
    })

    const adopted = await adoptBrowserHostClientPages([first, second], {}, fake.dependencies)

    expect(adopted).toEqual(['page-a', 'page-b'])
    expect([...fake.executionHostGrants.keys()]).toEqual(['page-a', 'page-b'])
    expect(fake.executionHostGrants.get('page-a')).toMatchObject({
      executionHostKey: first.executionHostKey,
      placement: clientPlacement(11)
    })
    expect(fake.releases.every((entry) => entry.release.mock.calls.length === 0)).toBe(true)
  })

  it('does not adopt a page whose committed placement carries a different pageHostGeneration', async () => {
    const candidate = intent({ pageHostGeneration: 11 })
    // A placement at another generation belongs to a later attempt, not to this intent's page.
    const fake = harness({ placements: { 'page-a': clientPlacement(12) } })

    const adopted = await adoptBrowserHostClientPages([candidate], {}, fake.dependencies)

    expect(adopted).toEqual([])
    expect(fake.executionHostGrants.has('page-a')).toBe(false)
    expect(fake.releases[0]?.release).toHaveBeenCalledTimes(1)
  })

  it('does not adopt a page with no committed placement and releases its grant', async () => {
    const fake = harness({ placements: { 'page-a': undefined } })

    const adopted = await adoptBrowserHostClientPages([intent()], {}, fake.dependencies)

    expect(adopted).toEqual([])
    expect(fake.executionHostGrants.size).toBe(0)
    expect(fake.releases[0]?.release).toHaveBeenCalledTimes(1)
  })

  it('does not adopt a page the runtime placed on the server instead', async () => {
    const fake = harness({ placements: { 'page-a': serverPlacement } })

    const adopted = await adoptBrowserHostClientPages([intent()], {}, fake.dependencies)

    expect(adopted).toEqual([])
    expect(fake.executionHostGrants.size).toBe(0)
    expect(fake.releases[0]?.release).toHaveBeenCalledTimes(1)
  })

  it('keeps an existing grant for the page id and releases the newly taken one', async () => {
    const existingRelease = vi.fn()
    const existing = {
      placement: clientPlacement(11),
      executionHostKey: 'native:runtime-old:1',
      release: existingRelease
    } as BrowserClientPageExecutionHostGrant
    const fake = harness({
      placements: { 'page-a': clientPlacement(11) },
      existingGrants: new Map([['page-a', existing]])
    })

    const adopted = await adoptBrowserHostClientPages([intent()], {}, fake.dependencies)

    expect(adopted).toEqual([])
    expect(fake.executionHostGrants.get('page-a')).toBe(existing)
    expect(existingRelease).not.toHaveBeenCalled()
    expect(fake.releases[0]?.release).toHaveBeenCalledTimes(1)
  })

  it('settles grants and keeps the placed pages when the reconcile rejects', async () => {
    const placed = intent({ browserPageId: 'page-placed', pageHostGeneration: 11 })
    const unplaced = intent({ browserPageId: 'page-unplaced', pageHostGeneration: 12 })
    const fake = harness({
      placements: { 'page-placed': clientPlacement(11), 'page-unplaced': undefined },
      adopt: () => Promise.reject(new Error('browser_host_reconcile_failed'))
    })

    // A partial reclaim must keep the pages it managed to place; releasing their grants would
    // strand a live guest behind a revoked tunnel.
    const adopted = await adoptBrowserHostClientPages([placed, unplaced], {}, fake.dependencies)

    expect(adopted).toEqual(['page-placed'])
    expect([...fake.executionHostGrants.keys()]).toEqual(['page-placed'])
    expect(fake.releases[1]?.release).toHaveBeenCalledTimes(1)
  })

  it('retains nothing and reconciles nothing when there are no intents', async () => {
    const fake = harness({ placements: {} })

    const adopted = await adoptBrowserHostClientPages([], {}, fake.dependencies)

    expect(adopted).toEqual([])
    expect(fake.retain).not.toHaveBeenCalled()
    expect(fake.adopt).not.toHaveBeenCalled()
  })

  it('retains exactly one grant per intent under that intent execution host key', async () => {
    const first = intent({ browserPageId: 'page-a', executionHostKey: 'native:runtime-new:1' })
    const second = intent({
      browserPageId: 'page-b',
      pageHostGeneration: 12,
      executionHostKey: 'ssh:host-b:2'
    })
    const fake = harness({
      placements: { 'page-a': clientPlacement(11), 'page-b': clientPlacement(12) }
    })

    await adoptBrowserHostClientPages([first, second], {}, fake.dependencies)

    expect(fake.retain).toHaveBeenCalledTimes(2)
    expect(fake.retain.mock.calls.map(([key]) => key)).toEqual([
      'native:runtime-new:1',
      'ssh:host-b:2'
    ])
  })
})
