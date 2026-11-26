import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopPhoneSharing } from '../../../commander/commander-phone-access'
import { CommanderPhoneListParams } from '../../../../shared/rpc-contract/commander-phone-params'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { COMMANDER_PHONE_METHODS } from './commander-phone'

const state = vi.hoisted(() => ({
  profileDirectory: '',
  cloud: { userId: 'alice', activeOrgId: 'org' },
  index: vi.fn(),
  get: vi.fn(),
  save: vi.fn()
}))
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/test'
}))
vi.mock('../../../orca-profiles/profile-index-store', () => ({
  readInitializedActiveOrcaProfile: async () => ({
    profile: { id: 'work', cloud: state.cloud },
    profileDirectory: state.profileDirectory
  })
}))
vi.mock('../../../commander/commander-memory-service', () => ({
  commanderMemoryService: { index: state.index, get: state.get },
  saveCommanderMemory: state.save
}))

const account = { profileId: 'work', userId: 'alice', activeOrgId: 'org' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only use the project list.
const runtime = {
  listVisibleProjectHostSetups: () => [{ projectId: 'app' }]
} as RpcContext['runtime']
const phone: RpcContext = {
  runtime,
  clientKind: 'mobile',
  pairedDeviceId: 'iphone',
  caller: { kind: 'paired-device', deviceId: 'iphone' }
}

async function call(name: string, params: unknown, ctx = phone) {
  const method = eraseRpcMethods(COMMANDER_PHONE_METHODS).find(
    (candidate) => candidate.name === `commanderPhone.${name}`
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing phone RPC')
  }
  return method.handler(params, ctx)
}

const page = {
  pageId: 'guide',
  kind: 'guideline',
  title: 'Test',
  body: 'private markdown',
  links: [],
  version: 2,
  actor: { type: 'human', id: 'alice' },
  createdBy: { type: 'human', id: 'alice' },
  deleted: false,
  createdAt: '2026-01-01'
}

beforeEach(async () => {
  vi.resetAllMocks()
  state.cloud = { userId: 'alice', activeOrgId: 'org' }
  state.profileDirectory = await mkdtemp(join(tmpdir(), 'commander-phone-'))
})
afterEach(async () => {
  await rm(state.profileDirectory, { recursive: true, force: true })
})

describe('Paired phone Commander memory', () => {
  it('requires desktop consent for the active org, and revokes it for existing connections', async () => {
    expect(await call('status', undefined)).toEqual({ state: 'disabled' })
    await expect(call('save', { account, write: {} })).rejects.toThrow('access changed')
    await desktopPhoneSharing(account, true)
    expect(await call('status', undefined)).toEqual({
      state: 'enabled',
      account,
      handoffs: true,
      handoffSearch: true
    })
    state.cloud.activeOrgId = 'other'
    await expect(call('read', { account, pageId: 'guide' })).rejects.toThrow('access changed')
    expect(await call('status', undefined)).toEqual({ state: 'disabled' })
    state.cloud.activeOrgId = 'org'
    await desktopPhoneSharing(account, false)
    await expect(call('list', { account })).rejects.toThrow('access changed')
  })
  it('rejects delegated phones, mismatched identities and agent callers even when sharing is enabled', async () => {
    await desktopPhoneSharing(account, true)
    for (const ctx of [
      { ...phone, pairedDeviceParentId: 'peer' },
      { ...phone, pairedDeviceId: 'other' },
      { ...phone, caller: { kind: 'paired-device', deviceId: 'iphone', agent: true } as const },
      { ...phone, clientKind: 'runtime' as const }
    ]) {
      await expect(call('read', { account, pageId: 'guide' }, ctx)).rejects.toThrow(
        'directly paired phone'
      )
    }
  })
  it('preserves the ID cursor and all known project choices when forwarding a filtered index page', async () => {
    await desktopPhoneSharing(account, true)
    state.index.mockResolvedValue({
      pages: [{ ...page, pageId: 'handoff-10000000-0000-4000-8000-000000000001', kind: 'note' }],
      projects: ['unregistered'],
      next: 'handoff-10000000-0000-4000-8000-000000000001'
    })
    const query = {
      after: 'bookmark',
      projectId: 'unregistered',
      handoffsOnly: true,
      includeDeleted: true
    }
    const result = await call('list', { account, ...query })
    expect(state.index).toHaveBeenCalledWith(
      account,
      { order: 'id', ...query },
      expect.any(Function)
    )
    expect(result).toMatchObject({
      pages: [{ pageId: 'handoff-10000000-0000-4000-8000-000000000001' }],
      next: 'handoff-10000000-0000-4000-8000-000000000001',
      projects: ['app', 'unregistered']
    })
  })
  it('continues a phone handoff search using the recent-order cursor and the same project', async () => {
    await desktopPhoneSharing(account, true)
    const cursor = '2026-11-23T18:30:00.000Z|handoff-10000000-0000-4000-8000-000000000001'
    const query = {
      handoffsOnly: true,
      order: 'recent',
      after: cursor,
      projectId: 'app',
      q: 'release'
    }
    state.index.mockResolvedValue({ pages: [], projects: ['app'], next: null })
    await call('list', CommanderPhoneListParams.parse({ ...query, account }))
    expect(state.index).toHaveBeenCalledWith(
      account,
      { ...query, validHandoffsOnly: true },
      expect.any(Function)
    )
  })
  it('discards an index response if the owner revokes phone sharing while it is in flight', async () => {
    await desktopPhoneSharing(account, true)
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<{ pages: []; projects: string[]; next: null }>()
    state.index.mockImplementation(() => {
      started.resolve()
      return response.promise
    })
    const result = call('list', { account })
    await started.promise
    await desktopPhoneSharing(account, false)
    response.resolve({ pages: [], projects: ['sensitive project'], next: null })
    await expect(result).rejects.toThrow('access changed')
  })
  it('returns the recurring question in the index and the requested Markdown revision on demand', async () => {
    await desktopPhoneSharing(account, true)
    state.index.mockResolvedValue({
      pages: [{ ...page, recurringQuestion: 'Where do release notes go?' }],
      projects: [],
      next: null
    })
    const result = await call('list', { account })
    expect(result).toMatchObject({
      pages: [{ pageId: 'guide', version: 2, recurringQuestion: 'Where do release notes go?' }]
    })
    expect(JSON.stringify(result)).not.toContain('private markdown')
    state.get.mockResolvedValue({ page, history: [{ ...page, body: 'original', version: 1 }] })
    expect(await call('read', { account, pageId: 'guide', version: 1 })).toMatchObject({
      page: { version: 2 },
      selectedRevision: { version: 1, body: 'original' }
    })
  })
})
