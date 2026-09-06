import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHostedWebViewRuntimeDirectory } from '../../scripts/hosted-webview-runtime-directory.mjs'

describe('hosted WebView runtime directory', () => {
  it('isolates each run while keeping the socket path short', () => {
    const first = resolveHostedWebViewRuntimeDirectory({
      worktree: '/repo/mobile-rearch',
      runNonce: 'run-one'
    })
    const second = resolveHostedWebViewRuntimeDirectory({
      worktree: '/repo/mobile-rearch',
      runNonce: 'run-two'
    })

    expect(first).not.toBe(second)
    expect(first).toMatch(/^\/tmp\/orca-mw-[a-f0-9]{8}-run-one$/)
    expect(
      path.join(first, 'emulator-control/userData/daemon/daemon-v27.sock').length
    ).toBeLessThan(104)
  })

  it('honors an explicit evidence directory', () => {
    expect(
      resolveHostedWebViewRuntimeDirectory({
        worktree: '/repo/mobile-rearch',
        override: './evidence',
        runNonce: 'ignored'
      })
    ).toBe(path.resolve('./evidence'))
  })
})
