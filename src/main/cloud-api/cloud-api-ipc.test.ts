import { beforeEach, describe, expect, it, vi } from 'vitest'

const callCloudApi = vi.fn(async (run: (client: unknown) => Promise<unknown>) => ({
  ok: true,
  data: await run(fakeClient)
}))
const fakeClient = {
  createApiKey: vi.fn(async (input: unknown) => ({ echoed: input })),
  revokeApiKey: vi.fn(async () => undefined),
  createRoutine: vi.fn(async (input: unknown) => ({ echoed: input }))
}

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('./cloud-api-service', () => ({
  callCloudApi: (run: (client: unknown) => Promise<unknown>) => callCloudApi(run),
  getCloudApiAvailability: () => ({ status: 'unconfigured' })
}))

const { cloudApiHandlerFor, CLOUD_API_CHANNELS } = await import('./cloud-api-ipc')

describe('cloud API IPC', () => {
  beforeEach(() => {
    callCloudApi.mockClear()
  })

  it('rejects malformed renderer input before any network call', async () => {
    const create = cloudApiHandlerFor('cloudApi:createApiKey')!
    expect(await create({ name: '', scopes: ['workspaces:read'] })).toEqual({
      ok: false,
      error: 'invalid-request'
    })
    expect(await create({ name: 'x', scopes: ['root:all'] })).toEqual({
      ok: false,
      error: 'invalid-request'
    })
    expect(await create({ name: 'x', scopes: ['audit:read'], extra: 1 })).toEqual({
      ok: false,
      error: 'invalid-request'
    })
    expect(await cloudApiHandlerFor('cloudApi:revokeApiKey')!(42)).toEqual({
      ok: false,
      error: 'invalid-request'
    })
    expect(
      await cloudApiHandlerFor('cloudApi:createRoutine')!({
        name: 'r',
        repo: { url: 'http://insecure.example/repo' },
        trigger: { kind: 'webhook' },
        agent: 'claude',
        prompt: 'p',
        postResults: 'none'
      })
    ).toEqual({ ok: false, error: 'invalid-request' })
    expect(callCloudApi).not.toHaveBeenCalled()
  })

  it('passes validated input through to the client', async () => {
    const result = await cloudApiHandlerFor('cloudApi:createApiKey')!({
      name: ' CI ',
      scopes: ['workspaces:read'],
      expiresInDays: 30
    })
    expect(result).toEqual({
      ok: true,
      data: { echoed: { name: 'CI', scopes: ['workspaces:read'], expiresInDays: 30 } }
    })
  })

  it('registers every channel the preload bridge uses', () => {
    expect(CLOUD_API_CHANNELS).toEqual(
      expect.arrayContaining([
        'cloudApi:availability',
        'cloudApi:createApproval',
        'cloudApi:listRoutineRuns',
        'cloudApi:rotateRoutineWebhook'
      ])
    )
  })
})
