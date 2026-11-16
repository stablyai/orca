import { describe, expect, it, vi } from 'vitest'
import { CloudWorkspaceSchema } from '../../shared/cloud-workspaces/cloud-workspaces-wire'
import { createCloudWorkspacesClient } from './cloud-workspaces-client'

const SBX = 'sbx_0123456789abcdef01234567'
const KEY = 'rk_aaaaaaaaaaaaaaaaaaaaaaaa'

function clientAnswering(status: number, body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { status })
  )
  const client = createCloudWorkspacesClient({
    baseUrl: 'https://cp.example.test',
    getAccessToken: async () => 'tok',
    fetch
  })
  return { client, fetch }
}

const sealed = {
  v: 1,
  snapshotId: 'snap_1',
  workspaceId: SBX,
  storedAt: 5,
  nonceB64: 'AAAAAAAAAAAAAAAA',
  ciphertextB64: 'AAAA',
  recipient: {
    keyId: KEY,
    ephemeralPublicKeyB64: 'AAAA',
    nonceB64: 'AAAA',
    wrappedKeyB64: 'AAAA'
  }
}

describe('cloud workspaces client: read snapshots', () => {
  it('PUTs the reader key and returns its id', async () => {
    const { client, fetch } = clientAnswering(200, {
      readerKey: { id: KEY, deviceKind: 'desktop', deviceLabel: 'mac', createdAt: 1, lastSeenAt: 2 }
    })
    const key = await client.registerReaderKey({
      publicKeyB64: 'pub',
      deviceLabel: 'mac',
      deviceKind: 'desktop'
    })
    expect(key.id).toBe(KEY)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://cp.example.test/v1/reader-keys')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({
      publicKeyB64: 'pub',
      deviceLabel: 'mac',
      deviceKind: 'desktop'
    })
  })

  it('DELETEs a reader key by id', async () => {
    const { client, fetch } = clientAnswering(200, { ok: true })
    await client.deleteReaderKey(KEY, 2_000)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`https://cp.example.test/v1/reader-keys/${KEY}`)
    expect(init?.method).toBe('DELETE')
  })

  it('GETs the sealed snapshot for this key', async () => {
    const { client, fetch } = clientAnswering(200, { snapshot: sealed })
    expect(await client.getReadSnapshot(SBX, KEY)).toEqual({ kind: 'sealed', sealed })
    expect(String(fetch.mock.calls[0]![0])).toBe(
      `https://cp.example.test/v1/team/workspaces/${SBX}/read-snapshot?keyId=${KEY}`
    )
  })

  it.each(['not_found', 'no_snapshot', 'not_sealed_for_key'] as const)(
    'maps 404 %s to a typed result',
    async (code) => {
      const { client } = clientAnswering(404, { error: code })
      expect(await client.getReadSnapshot(SBX, KEY)).toEqual({ kind: code })
    }
  )

  it('keeps other failures as errors', async () => {
    await expect(
      clientAnswering(404, { error: 'something_else' }).client.getReadSnapshot(SBX, KEY)
    ).rejects.toMatchObject({ status: 404, code: 'something_else' })
    await expect(
      clientAnswering(400, { error: 'invalid_request' }).client.getReadSnapshot(SBX, KEY)
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })
})

describe('CloudWorkspaceSchema.readSnapshotAt', () => {
  const base = {
    id: SBX,
    workspaceId: 'w',
    status: 'suspended',
    machineSize: 'standard',
    region: 'iad1',
    createdAt: 1,
    title: null,
    repo: null,
    visibility: 'team',
    section: null,
    archivedAt: null,
    createdBy: 'u',
    ownerUserId: 'u',
    lastActivityAt: 1,
    lastActivityBy: null,
    cost: {
      computeMs: 0,
      rateUsdMicrosPerHour: 0,
      computeUsdMicros: 0,
      tokenUsdMicros: null,
      totalUsdMicros: 0
    },
    access: 'can_open',
    presence: []
  }
  it('is optional for older control planes and nullable', () => {
    expect(CloudWorkspaceSchema.parse(base).readSnapshotAt).toBeUndefined()
    expect(CloudWorkspaceSchema.parse({ ...base, readSnapshotAt: null }).readSnapshotAt).toBeNull()
    expect(CloudWorkspaceSchema.parse({ ...base, readSnapshotAt: 9 }).readSnapshotAt).toBe(9)
  })
})

describe('cloud workspaces client: sleep and delete', () => {
  // The control plane answers both with the sandbox's new state; reading `{ok}` turned a finished
  // delete into "invalid_response" (np4-e2e).
  it('reads a delete answered with the destroyed sandbox as done', async () => {
    const { client, fetch } = clientAnswering(200, { sandbox: { id: SBX, status: 'destroyed' } })
    await expect(client.destroy(SBX)).resolves.toBeUndefined()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`https://cp.example.test/v1/sandboxes/${SBX}`)
    expect(init?.method).toBe('DELETE')
  })

  it('never calls a delete done unless the sandbox is destroyed', async () => {
    const { client } = clientAnswering(200, { sandbox: { id: SBX, status: 'running' } })
    await expect(client.destroy(SBX)).rejects.toMatchObject({ code: 'not_destroyed' })
  })

  it('reads a sleep answered with the suspended sandbox as done', async () => {
    const { client, fetch } = clientAnswering(200, { sandbox: { id: SBX, status: 'suspended' } })
    await expect(client.sleep(SBX)).resolves.toBeUndefined()
    expect(String(fetch.mock.calls[0]![0])).toBe(
      `https://cp.example.test/v1/sandboxes/${SBX}/suspend`
    )
  })
})

describe('cloud workspaces client: routine runs on Home', () => {
  it('asks for routine runs only when the filter is on, and keeps the routine mark', async () => {
    const row = {
      id: SBX,
      workspaceId: 'routine-run_1',
      status: 'running',
      machineSize: 'standard',
      region: 'pdx1',
      createdAt: 1,
      title: 'Nightly · run',
      repo: null,
      visibility: 'private',
      section: null,
      archivedAt: null,
      createdBy: 'u1',
      ownerUserId: 'u1',
      lastActivityAt: 1,
      lastActivityBy: null,
      cost: {
        computeMs: 0,
        rateUsdMicrosPerHour: 0,
        computeUsdMicros: 0,
        tokenUsdMicros: null,
        totalUsdMicros: 0
      },
      access: 'owner',
      presence: [],
      fromRoutine: true
    }
    const { client, fetch } = clientAnswering(200, { workspaces: [row] })
    const listed = (await client.list({ scope: 'mine', archived: 'exclude', routines: 'include' }))
      .workspaces
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://cp.example.test/v1/team/workspaces?scope=mine&archived=exclude&routines=include'
    )
    expect(listed[0]!.fromRoutine).toBe(true)
    // Older control planes omit the mark; it is never required.
    const { fromRoutine: _omitted, ...older } = row
    expect(CloudWorkspaceSchema.parse(older).fromRoutine).toBeUndefined()
  })
})

describe('cloud workspaces client: owner change (OWNER-TRANSFER)', () => {
  const row = {
    id: SBX,
    workspaceId: 'ws_1',
    status: 'suspended',
    machineSize: 'standard',
    region: 'iad',
    createdAt: 1,
    title: 'Checkout retries',
    repo: null,
    visibility: 'private',
    section: null,
    archivedAt: null,
    createdBy: 'user_grace',
    ownerUserId: 'user_linus',
    lastActivityAt: 2,
    lastActivityBy: null,
    cost: {
      computeMs: 0,
      rateUsdMicrosPerHour: 0,
      computeUsdMicros: 0,
      tokenUsdMicros: null,
      totalUsdMicros: 0
    },
    access: 'none',
    presence: [],
    ownershipTransferredAt: 5
  }

  it('PATCHes the new owner and keeps the transferred mark and who was told', async () => {
    const previousOwner = { userId: 'user_grace', notified: true, inApp: true, emailed: false }
    const { client, fetch } = clientAnswering(200, { workspace: row, previousOwner })
    const answer = await client.changeOwner(SBX, 'user_linus')
    expect(answer.workspace.ownershipTransferredAt).toBe(5)
    expect(answer.previousOwner).toEqual(previousOwner)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`https://cp.example.test/v1/team/workspaces/${SBX}`)
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe(JSON.stringify({ ownerUserId: 'user_linus' }))
  })

  it('an older control plane that says nothing about the previous owner is not an error', async () => {
    const { client } = clientAnswering(200, { workspace: row })
    expect((await client.changeOwner(SBX, 'user_linus')).previousOwner).toBeNull()
  })

  it('passes a refusal through with its reason', async () => {
    const { client } = clientAnswering(409, { error: 'conflict', reason: 'stop_failed' })
    await expect(client.changeOwner(SBX, 'user_linus')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      reason: 'stop_failed'
    })
  })

  it('reads the previous owner’s notices, skipping kinds it does not know', async () => {
    const notice = {
      id: 'otn_0123456789abcdef01234567',
      kind: 'workspace_owner_changed',
      workspace: { id: SBX, name: 'Checkout retries', number: 12 },
      actor: { userId: 'user_ada', name: 'Ada Lovelace' },
      newOwner: { userId: 'user_linus', name: null },
      at: 9
    }
    const { client, fetch } = clientAnswering(200, {
      notices: [notice, { id: 'x_1', kind: 'something_newer' }]
    })
    expect(await client.ownerNotices()).toEqual([notice])
    expect(String(fetch.mock.calls[0]![0])).toBe('https://cp.example.test/v1/team/notices')
  })

  it('dismisses a notice by id', async () => {
    const { client, fetch } = clientAnswering(200, { dismissed: true })
    await client.dismissOwnerNotice('otn_0123456789abcdef01234567')
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(
      'https://cp.example.test/v1/team/notices/otn_0123456789abcdef01234567/dismiss'
    )
    expect(init?.method).toBe('POST')
  })
})
