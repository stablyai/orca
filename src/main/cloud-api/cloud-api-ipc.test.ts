import { describe, expect, it, vi } from 'vitest'

const handle = vi.fn()
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler: vi.fn() } }))
vi.mock('./cloud-api-service', () => ({
  getCloudApiAvailability: () => ({ status: 'unconfigured' })
}))

const { CLOUD_API_CHANNELS, registerCloudApiHandlers } = await import('./cloud-api-ipc')

describe('cloud API IPC', () => {
  it('registers only the availability probe; keys, apps and routines live in the web console', async () => {
    registerCloudApiHandlers()
    expect(CLOUD_API_CHANNELS).toEqual(['cloudApi:availability'])
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(['cloudApi:availability'])
    const [, availability] = handle.mock.calls[0]
    expect(await availability()).toEqual({ status: 'unconfigured' })
  })
})
