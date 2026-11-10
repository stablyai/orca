import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => void store.set(key, value),
    removeItem: async (key: string) => void store.delete(key)
  }
}))
vi.mock('../transport/hosts/host-store', () => ({ loadHostCatalog: async () => [] }))
vi.mock('./cloud-workspace-attach', () => ({
  CloudAttachError: class CloudAttachError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
}))

import { isCloudWorkspaceGoneFromRegistry } from './cloud-control-plane-client'
import { CloudRequestError } from './cloud-control-plane-request'
import {
  isCloudWorkspaceGone,
  pruneCloudHostsMissingFrom,
  pruneGoneCloudHost
} from './cloud-host-pruning'
import { enqueueCloudPrompt, listQueuedCloudPrompts } from './cloud-prompt-queue'
import { CloudAttachError } from './cloud-workspace-attach'
import {
  cloudWorkspaceHostIds,
  cloudWorkspaceProjectRoot,
  recordCloudWorkspaceHost
} from './cloud-workspace-links'

const LINKS_KEY = 'orca:cloud-workspace-hosts:v1'
type SeedLink = { hostId?: string; pairedAt?: number; updatedAt?: number; projectRoot?: string }

function seedLinks(links: Record<string, SeedLink>) {
  store.set(LINKS_KEY, JSON.stringify(links))
}

const goneOnly =
  (...ids: string[]) =>
  async (sandboxId: string) =>
    ids.includes(sandboxId)

describe('pruning hosts of gone cloud workspaces', () => {
  beforeEach(() => {
    store.clear()
  })

  it('forgets the host, link and queued prompts of a missing workspace the registry confirms is gone', async () => {
    seedLinks({
      sbx_gone: { hostId: 'host-gone', pairedAt: 1_000, updatedAt: 1_000 },
      sbx_live: { hostId: 'host-live', pairedAt: 1_000, updatedAt: 1_000 }
    })
    await enqueueCloudPrompt({
      sandboxId: 'sbx_gone',
      text: 'never delivered',
      agent: 'claude',
      operationId: 'op-1'
    })
    await enqueueCloudPrompt({
      sandboxId: 'sbx_live',
      text: 'still wanted',
      agent: 'claude',
      operationId: 'op-2'
    })
    const removed: string[] = []
    const confirmGone = vi.fn(goneOnly('sbx_gone'))

    const pruned = await pruneCloudHostsMissingFrom(
      new Set(['sbx_live']),
      5_000,
      confirmGone,
      async (hostId) => {
        removed.push(hostId)
      }
    )

    expect(pruned).toEqual(['sbx_gone'])
    // Only the workspace the list lacks is checked by id.
    expect(confirmGone.mock.calls).toEqual([['sbx_gone']])
    expect(removed).toEqual(['host-gone'])
    expect([...(await cloudWorkspaceHostIds())]).toEqual(['host-live'])
    expect(await listQueuedCloudPrompts('sbx_gone')).toEqual([])
    expect(await listQueuedCloudPrompts('sbx_live')).toHaveLength(1)
  })

  it('keeps a missing workspace the registry still serves (capped list, hidden row, teammate share) or cannot answer for', async () => {
    seedLinks({
      sbx_hidden: { hostId: 'host-hidden', pairedAt: 1_000 },
      sbx_unknown: { hostId: 'host-unknown', pairedAt: 1_000 }
    })
    const removeHost = vi.fn(async () => undefined)
    const confirmGone = async (sandboxId: string) => {
      if (sandboxId === 'sbx_unknown') {
        throw new Error('offline')
      }
      return false
    }
    // An empty list (a server bug, or a capped page) proves nothing on its own.
    expect(await pruneCloudHostsMissingFrom(new Set(), 5_000, confirmGone, removeHost)).toEqual([])
    expect(removeHost).not.toHaveBeenCalled()
    expect([...(await cloudWorkspaceHostIds())].sort()).toEqual(['host-hidden', 'host-unknown'])
  })

  it('never checks a link written after the list request started (created or paired meanwhile)', async () => {
    seedLinks({ sbx_new: { hostId: 'host-new', pairedAt: 6_000, updatedAt: 6_000 } })
    const confirmGone = vi.fn(async () => true)
    expect(
      await pruneCloudHostsMissingFrom(new Set(), 5_000, confirmGone, async () => undefined)
    ).toEqual([])
    expect(confirmGone).not.toHaveBeenCalled()
    expect([...(await cloudWorkspaceHostIds())]).toEqual(['host-new'])
  })

  it('puts the link back when the host cannot be removed, so the next confirmed miss retries', async () => {
    seedLinks({
      sbx_gone: { hostId: 'host-gone', pairedAt: 1_000, projectRoot: '/vercel/sandbox/project' }
    })
    await enqueueCloudPrompt({
      sandboxId: 'sbx_gone',
      text: 'kept with its link',
      agent: 'claude',
      operationId: 'op-3'
    })
    const pruned = await pruneCloudHostsMissingFrom(
      new Set(),
      5_000,
      goneOnly('sbx_gone'),
      async () => {
        throw new Error('host store busy')
      }
    )
    expect(pruned).toEqual([])
    expect([...(await cloudWorkspaceHostIds())]).toEqual(['host-gone'])
    expect(await cloudWorkspaceProjectRoot('sbx_gone')).toBe('/vercel/sandbox/project')
    expect(await listQueuedCloudPrompts('sbx_gone')).toHaveLength(1)
  })

  it('forgets exactly one workspace on its own confirmed not_found', async () => {
    await recordCloudWorkspaceHost('sbx_gone', 'host-gone')
    await recordCloudWorkspaceHost('sbx_other', 'host-other')
    const removed: string[] = []
    expect(
      await pruneGoneCloudHost('sbx_gone', async (hostId) => {
        removed.push(hostId)
      })
    ).toEqual(['sbx_gone'])
    expect(removed).toEqual(['host-gone'])
    expect([...(await cloudWorkspaceHostIds())]).toEqual(['host-other'])
  })

  it('asks about a still-present missing workspace once per few minutes, and shares one run between overlapping polls', async () => {
    seedLinks({ sbx_capped: { hostId: 'host-capped', pairedAt: 1_000 } })
    const confirmGone = vi.fn(async () => false)
    const removeHost = async () => undefined
    const [first, second] = await Promise.all([
      pruneCloudHostsMissingFrom(new Set(), 5_000, confirmGone, removeHost),
      pruneCloudHostsMissingFrom(new Set(), 5_000, confirmGone, removeHost)
    ])
    expect(first).toEqual([])
    expect(second).toEqual([])
    await pruneCloudHostsMissingFrom(new Set(), 5_000, confirmGone, removeHost)
    expect(confirmGone).toHaveBeenCalledTimes(1)
    expect([...(await cloudWorkspaceHostIds())]).toEqual(['host-capped'])
  })

  it('treats only confirmed answers as gone, never transient failures', () => {
    expect(isCloudWorkspaceGone(new CloudAttachError('not_found'))).toBe(true)
    expect(isCloudWorkspaceGone(new CloudRequestError('not_found', 404))).toBe(true)
    expect(isCloudWorkspaceGone(new CloudRequestError('network_error', 0))).toBe(false)
    expect(isCloudWorkspaceGone(new CloudRequestError('timeout', 0))).toBe(false)
    expect(isCloudWorkspaceGone(new CloudRequestError('provider_unavailable', 502))).toBe(false)
    expect(isCloudWorkspaceGone(new CloudRequestError('unauthorized', 401))).toBe(false)
    expect(isCloudWorkspaceGone(new CloudAttachError('wake_timeout'))).toBe(false)
    expect(isCloudWorkspaceGone(new Error('offline'))).toBe(false)
  })
})

describe('isCloudWorkspaceGoneFromRegistry', () => {
  const plane = (reply: () => Promise<Response>) => ({
    baseUrl: 'https://cp.test',
    token: () => 'tok',
    fetch: async () => reply()
  })

  it('is true only for the registry’s own 404 not_found', async () => {
    const answer = (status: number, body: unknown) => async () => Response.json(body, { status })
    expect(
      await isCloudWorkspaceGoneFromRegistry(plane(answer(404, { error: 'not_found' })), 'sbx')
    ).toBe(true)
    expect(
      await isCloudWorkspaceGoneFromRegistry(plane(answer(200, { workspace: {} })), 'sbx')
    ).toBe(false)
    expect(
      await isCloudWorkspaceGoneFromRegistry(plane(answer(500, { error: 'internal' })), 'sbx')
    ).toBe(false)
    expect(
      await isCloudWorkspaceGoneFromRegistry(plane(answer(404, { error: 'route_missing' })), 'sbx')
    ).toBe(false)
    expect(
      await isCloudWorkspaceGoneFromRegistry(
        plane(async () => {
          throw new TypeError('Network request failed')
        }),
        'sbx'
      )
    ).toBe(false)
  })
})
