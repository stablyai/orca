import { describe, expect, it, vi } from 'vitest'

import { requestGuestOpenCodeOverlayDir } from './wsl-guest-plugin-install'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

function fakeMux(
  request: () => Promise<unknown>,
  isDisposed = false
): { mux: SshChannelMultiplexer } {
  return { mux: { request, isDisposed: () => isDisposed } as unknown as SshChannelMultiplexer }
}

function deps() {
  return {
    pluginSources: () => ({ opencodePluginSource: '// src' }),
    warn: vi.fn<(message: string) => void>()
  }
}

describe('requestGuestOpenCodeOverlayDir', () => {
  it("reports 'none' when the guest answered but materialization produced no dir", async () => {
    // A failed rebuild invalidates the previously recorded overlay, unlike an unavailable guest.
    const { mux } = fakeMux(async () => ({ installed: { opencode: true }, overlayDirs: {} }))
    await expect(requestGuestOpenCodeOverlayDir(mux, deps(), 'Ubuntu')).resolves.toEqual({
      kind: 'none'
    })
  })

  it("reports 'unavailable' for an older guest bundle and for teardown, without warning", async () => {
    for (const code of [-32601, 'CONNECTION_LOST', 'DISPOSED']) {
      const d = deps()
      const { mux } = fakeMux(async () => {
        throw Object.assign(new Error('nope'), { code })
      })
      await expect(requestGuestOpenCodeOverlayDir(mux, d, 'Ubuntu')).resolves.toEqual({
        kind: 'unavailable'
      })
      expect(d.warn).not.toHaveBeenCalled()
    }
  })
})
