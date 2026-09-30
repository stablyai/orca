import { describe, expect, it, vi } from 'vitest'
import {
  OFFSCREEN_PAGE_GUEST_CHANNELS,
  OFFSCREEN_PAGE_GUEST_KIND_CHANNEL
} from '../shared/offscreen-page-guest-channels'
import { GUEST_KIND_CHANNEL, installOffscreenPageGuest } from './offscreen-page-guest'

describe('installOffscreenPageGuest', () => {
  it('asks main on the channel main answers', () => {
    expect(GUEST_KIND_CHANNEL).toBe(OFFSCREEN_PAGE_GUEST_KIND_CHANNEL)
  })

  it('installs nothing for a webview page', async () => {
    const ipc = { invoke: vi.fn(() => Promise.resolve(null)), on: vi.fn(), send: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every IpcRenderer member the installer touches.
    installOffscreenPageGuest(ipc as never)
    await Promise.resolve()
    await Promise.resolve()
    expect(ipc.on).not.toHaveBeenCalled()
  })

  it('listens for datalist queries on the channel main names', async () => {
    vi.stubGlobal('addEventListener', vi.fn())
    vi.stubGlobal('document', { addEventListener: vi.fn() })
    const ipc = {
      invoke: vi.fn(() => Promise.resolve(OFFSCREEN_PAGE_GUEST_CHANNELS)),
      on: vi.fn(),
      send: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every IpcRenderer member the installer touches.
    installOffscreenPageGuest(ipc as never)
    await Promise.resolve()
    await Promise.resolve()
    expect(ipc.on).toHaveBeenCalledWith(
      OFFSCREEN_PAGE_GUEST_CHANNELS.datalistQuery,
      expect.any(Function)
    )
    vi.unstubAllGlobals()
  })
})
