import { describe, expect, it, vi } from 'vitest'
import { activateHostedWorkspaceRow } from '../../scripts/hosted-webview-workspace-activation.mjs'

describe('hosted WebView workspace activation', () => {
  it('prefers the existing accessible workspace-row label', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    const document = { href: 'orca-mobile-web://build/' }

    await activateHostedWorkspaceRow(document, 'mobile-rearch', activate)

    expect(activate).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledWith(document, {
      kind: 'label',
      value: 'Open mobile-rearch',
      reveal: true
    })
  })

  it('reveals a grouped text row when accessible row labels are absent', async () => {
    const missing = new Error('Hosted WebView control was not found: mobile-rearch')
    const activate = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await activateHostedWorkspaceRow({}, 'mobile-rearch', activate)

    expect(activate).toHaveBeenNthCalledWith(
      2,
      {},
      {
        kind: 'text',
        value: 'mobile-rearch',
        ignoreCase: true,
        occurrence: 1,
        reveal: true
      }
    )
    expect(activate).toHaveBeenNthCalledWith(
      3,
      {},
      {
        kind: 'text',
        value: 'mobile-rearch',
        ignoreCase: true,
        reveal: true
      }
    )
    expect(activate).toHaveBeenNthCalledWith(
      4,
      {},
      {
        kind: 'text',
        value: 'mobile-rearch',
        ignoreCase: true,
        occurrence: 1,
        reveal: true
      }
    )
  })

  it('reacquires a replaced WebKit document before retrying', async () => {
    const stale = new Error('WebKit CDP connection closed')
    const activate = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(undefined)
    const replacement = { href: 'orca-mobile-web://replacement/' }
    const resolveDocument = vi.fn().mockResolvedValue(replacement)

    await activateHostedWorkspaceRow(
      { href: 'orca-mobile-web://stale/' },
      'mobile-rearch',
      activate,
      1_000,
      resolveDocument
    )

    expect(resolveDocument).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenLastCalledWith(replacement, {
      kind: 'label',
      value: 'Open mobile-rearch',
      reveal: true
    })
  })

  it('reacquires an Android target replaced during its inspector handshake', async () => {
    const stale = new Error('Unexpected server response: 500')
    const activate = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(undefined)
    const replacement = { href: 'https://orca-mobile-web.invalid/' }
    const resolveDocument = vi.fn().mockResolvedValue(replacement)

    await activateHostedWorkspaceRow(
      { href: 'https://orca-mobile-web.invalid/' },
      'mobile-rearch',
      activate,
      1_000,
      resolveDocument
    )

    expect(resolveDocument).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenLastCalledWith(replacement, {
      kind: 'label',
      value: 'Open mobile-rearch',
      reveal: true
    })
  })

  it('retries after a grouped row is not visible immediately', async () => {
    const missing = new Error('Hosted WebView control was not found: mobile-rearch')
    const activate = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined)

    await activateHostedWorkspaceRow({}, 'mobile-rearch', activate, 1_000)

    expect(activate).toHaveBeenCalledTimes(6)
    expect(activate).toHaveBeenLastCalledWith({}, expect.objectContaining({ reveal: true }))
  })

  it('accepts activation of the only matching text row', async () => {
    const missing = new Error('Hosted WebView control was not found: mobile-rearch')
    const stale = new Error('WebKit CDP connection closed')
    const activate = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(stale)

    await activateHostedWorkspaceRow({}, 'mobile-rearch', activate)

    expect(activate).toHaveBeenCalledTimes(4)
  })

  it('accepts an SPA route transition after the activated row disappears', async () => {
    const missing = new Error('Hosted WebView control was not found: mobile-rearch')
    const activate = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(missing)
    const resolveDocument = vi.fn().mockResolvedValue({
      href: 'https://orca-mobile-web.invalid/h/host/session/workspace'
    })

    await activateHostedWorkspaceRow(
      { href: 'https://orca-mobile-web.invalid/h/host' },
      'mobile-rearch',
      activate,
      1_000,
      resolveDocument
    )

    expect(resolveDocument).toHaveBeenCalledOnce()
  })
})
