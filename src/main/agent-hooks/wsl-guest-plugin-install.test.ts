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
  it('reports the guest overlay dir', async () => {
    const { mux } = fakeMux(async () => ({ overlayDirs: { opencode: '/home/jin/.orca-relay/x' } }))
    await expect(requestGuestOpenCodeOverlayDir(mux, deps(), 'Ubuntu')).resolves.toEqual({
      kind: 'dir',
      dir: '/home/jin/.orca-relay/x'
    })
  })

  // Why: each OpenCode major gets its own guest overlay. Collapsing them here would
  // point an OpenCode 2 pane at the v1 overlay, whose plugin gates itself off.
  it('carries the per-major guest overlay dirs independently', async () => {
    const { mux } = fakeMux(async () => ({
      overlayDirs: {
        opencode: '/home/jin/.orca-relay/opencode-overlays/x',
        opencode2: '/home/jin/.orca-relay/opencode2-overlays/y'
      }
    }))
    await expect(requestGuestOpenCodeOverlayDir(mux, deps(), 'Ubuntu')).resolves.toEqual({
      kind: 'dir',
      dir: '/home/jin/.orca-relay/opencode-overlays/x',
      dir2: '/home/jin/.orca-relay/opencode2-overlays/y'
    })
  })

  it('reports an OpenCode 2 overlay even when the v1 overlay is missing', async () => {
    const { mux } = fakeMux(async () => ({
      overlayDirs: { opencode2: '/home/jin/.orca-relay/opencode2-overlays/y' }
    }))
    await expect(requestGuestOpenCodeOverlayDir(mux, deps(), 'Ubuntu')).resolves.toEqual({
      kind: 'dir',
      dir2: '/home/jin/.orca-relay/opencode2-overlays/y'
    })
  })

  it("reports 'none' when the guest answered but materialization produced no dir", async () => {
    // Why: distinct from 'unavailable' — the caller must CLEAR a previously recorded
    // dir here, since a rebuild that failed after wiping leaves it plugin-less.
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

  it("warns but still reports 'unavailable' on an unexpected failure", async () => {
    const d = deps()
    const { mux } = fakeMux(async () => {
      throw new Error('boom')
    })
    await expect(requestGuestOpenCodeOverlayDir(mux, d, 'Ubuntu')).resolves.toEqual({
      kind: 'unavailable'
    })
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})
