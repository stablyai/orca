import { describe, expect, it, vi } from 'vitest'
import { MobileWebBrowserRequestClient } from './mobile-web-browser-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const TARGET = { workspaceId: 'workspace-1', pageId: 'browser-1' } as const

function fixture(result: unknown = { applied: true }) {
  const request = vi.fn(async (..._args: unknown[]) => result)
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  return { request, client: new MobileWebBrowserRequestClient(requests) }
}

function payloads(
  request: ReturnType<typeof fixture>['request']
): { method: string; workspaceId?: string; params: Record<string, unknown> }[] {
  return request.mock.calls.map(
    (call) => call[2] as { method: string; workspaceId?: string; params: Record<string, unknown> }
  )
}

describe('page-owned browser commands', () => {
  it('names the workspace in the envelope and the page in the params', async () => {
    const f = fixture({ url: 'https://app.example/' })

    await expect(f.client.navigate({ ...TARGET, url: 'https://app.example/' })).resolves.toEqual({
      url: 'https://app.example/'
    })

    expect(payloads(f.request)).toEqual([
      {
        method: 'mobileWeb.browser.navigate',
        workspaceId: 'workspace-1',
        params: { page: 'browser-1', url: 'https://app.example/' }
      }
    ])
  })

  it('sends one host request per pointer, keyboard and dialog action', async () => {
    const f = fixture()

    await expect(
      f.client.pointer({ ...TARGET, action: 'scroll', x: 1, y: 2, dx: 0, dy: -30 })
    ).resolves.toBeNull()
    await f.client.pointer({
      ...TARGET,
      action: 'click',
      x: 3,
      y: 4,
      button: 'left',
      modifiers: ['cmd'],
      radius: 8
    })
    await f.client.keyboard({ ...TARGET, action: 'insertText', text: 'hi' })
    await f.client.keyboard({ ...TARGET, action: 'keypress', key: 'Escape' })
    await f.client.dialog({ ...TARGET, action: 'accept' })

    expect(payloads(f.request)).toEqual([
      {
        method: 'mobileWeb.browser.pointer',
        workspaceId: 'workspace-1',
        params: { page: 'browser-1', action: 'scroll', x: 1, y: 2, dx: 0, dy: -30 }
      },
      {
        method: 'mobileWeb.browser.pointer',
        workspaceId: 'workspace-1',
        params: {
          page: 'browser-1',
          action: 'click',
          x: 3,
          y: 4,
          button: 'left',
          modifiers: ['cmd'],
          radius: 8
        }
      },
      {
        method: 'mobileWeb.browser.keyboard',
        workspaceId: 'workspace-1',
        params: { page: 'browser-1', action: 'insertText', text: 'hi' }
      },
      {
        method: 'mobileWeb.browser.keyboard',
        workspaceId: 'workspace-1',
        params: { page: 'browser-1', action: 'keypress', key: 'Escape' }
      },
      {
        method: 'mobileWeb.browser.dialog',
        workspaceId: 'workspace-1',
        params: { page: 'browser-1', action: 'accept' }
      }
    ])
  })

  it('carries back, forward and reload as one history method', async () => {
    const f = fixture()

    await f.client.back(TARGET)
    await f.client.forward(TARGET)
    await f.client.reload(TARGET)

    expect(payloads(f.request)).toEqual(
      ['back', 'forward', 'reload'].map((action) => ({
        method: 'mobileWeb.browser.history',
        workspaceId: 'workspace-1',
        params: { page: 'browser-1', action }
      }))
    )
  })

  it('rejects a command the host did not acknowledge as applied', async () => {
    const f = fixture({ applied: false })

    await expect(f.client.reload(TARGET)).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('rejects a navigation result with no URL and tolerates an unknown field', async () => {
    const f = fixture({ title: 'App' })
    await expect(f.client.navigate({ ...TARGET, url: 'https://a.example/' })).rejects.toMatchObject(
      {
        code: 'invalid_message'
      }
    )

    const forwardCompatible = fixture({ url: 'https://a.example/', title: 'App' })
    await expect(
      forwardCompatible.client.navigate({ ...TARGET, url: 'https://a.example/' })
    ).resolves.toEqual({ url: 'https://a.example/' })
  })

  it('never forwards the opaque workspace handle inside the host params', async () => {
    const f = fixture()

    await f.client.dialog({ ...TARGET, action: 'dismiss' })

    expect(JSON.stringify(payloads(f.request)[0]!.params)).not.toContain('workspace-1')
  })
})
