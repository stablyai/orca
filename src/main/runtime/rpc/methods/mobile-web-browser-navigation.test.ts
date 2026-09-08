import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'
import { MOBILE_WEB_BROWSER_NAVIGATION_METHODS } from './mobile-web-browser-navigation'

const methods = new Map(
  MOBILE_WEB_BROWSER_NAVIGATION_METHODS.map((method) => [method.name, method])
)
const navigate = methods.get('mobileWeb.browser.navigate')!
const history = methods.get('mobileWeb.browser.history')!

const TARGET = { worktree: 'id:workspace', page: 'page-1' }

function fixture(landing: unknown) {
  const runtime = {
    browserGoto: vi.fn().mockResolvedValue(landing),
    browserBack: vi.fn().mockResolvedValue({ url: 'https://secret.example/?token=abc' }),
    browserForward: vi.fn().mockResolvedValue({ url: 'https://secret.example/' }),
    browserReload: vi.fn().mockResolvedValue({ url: 'https://secret.example/' })
  }
  return { runtime, context: { runtime } as unknown as RpcContext }
}

describe('host-owned browser navigation', () => {
  it('strips credentials from the URL the page is told it landed on', async () => {
    const f = fixture({ url: 'https://app.example/callback?code=secret&view=1', title: 'App' })

    expect(await navigate.handler({ ...TARGET, url: 'https://app.example/' }, f.context)).toEqual({
      url: 'https://app.example/callback?view=1'
    })
    expect(f.runtime.browserGoto).toHaveBeenCalledWith({ ...TARGET, url: 'https://app.example/' })
  })

  it('answers about:blank when the host reports no usable URL', async () => {
    const f = fixture({ title: 'App' })

    expect(await navigate.handler({ ...TARGET, url: 'https://app.example/' }, f.context)).toEqual({
      url: 'about:blank'
    })
  })

  it('refuses a navigation URL that is not a credential-free http target', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://a.example/?token=t']) {
      expect(navigate.params!.safeParse({ ...TARGET, url }).success, url).toBe(false)
    }
    expect(navigate.params!.safeParse({ ...TARGET, url: 'https://a.example/x' }).success).toBe(true)
  })

  it('acknowledges history moves without echoing the host tab URL', async () => {
    const f = fixture({ url: 'https://app.example/' })

    for (const action of ['back', 'forward', 'reload'] as const) {
      expect(await history.handler({ ...TARGET, action }, f.context)).toEqual({ applied: true })
    }

    expect(f.runtime.browserBack).toHaveBeenCalledWith(TARGET)
    expect(f.runtime.browserForward).toHaveBeenCalledWith(TARGET)
    expect(f.runtime.browserReload).toHaveBeenCalledWith(TARGET)
  })

  it('exposes every navigation method to the page lane', () => {
    for (const name of methods.keys()) {
      expect(isMobileWebHostRpcMethod(name), name).toBe(true)
    }
  })
})
