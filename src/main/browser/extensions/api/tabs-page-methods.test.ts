import { describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../browser-extension-namespace-registry'

const mocks = vi.hoisted(() => ({
  history: {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: vi.fn(),
    goForward: vi.fn()
  },
  page: { lang: 'pt-BR' }
}))

vi.mock('../browser-extension-tab-model', () => {
  const contents = {
    id: 4,
    navigationHistory: mocks.history,
    executeJavaScriptInIsolatedWorld: vi.fn(async () => mocks.page.lang)
  }
  const entry = { contents, windowId: 1, active: true }
  return {
    requireCallerTab: (_caller: unknown, id: number) => {
      if (id !== 4) {
        throw new Error(`No tab with id: ${id}.`)
      }
      return entry
    },
    listBrowserExtensionTabs: () => [entry],
    resolveCallerWindowId: () => 1,
    describeBrowserExtensionTab: (_extension: unknown, tab: typeof entry) => ({
      id: tab.contents.id,
      discarded: false
    })
  }
})

const { tabsPageMethods } = await import('./tabs-page-methods')

function call(method: string, args: unknown[]) {
  return new Promise((resolve) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods only pass the caller to the mocked tab model.
    resolve(tabsPageMethods[method].invoke({} as BrowserExtensionCaller, args))
  )
}

describe('tabs page methods', () => {
  it('navigates history and refuses a missing page', async () => {
    await call('goBack', [])
    expect(mocks.history.goBack).toHaveBeenCalledTimes(1)
    await expect(call('goForward', [4])).rejects.toThrow('Cannot find a next page in history.')
  })

  it('answers move and discard with the unchanged tabs', async () => {
    await expect(call('move', [[4], { index: 0 }])).resolves.toEqual([{ id: 4, discarded: false }])
    await expect(call('move', [4, { index: -1 }])).resolves.toEqual({ id: 4, discarded: false })
    await expect(call('discard', [4])).resolves.toEqual({ id: 4, discarded: false })
  })

  it("reads the page's language from <html lang>, 'und' without one", async () => {
    await expect(call('detectLanguage', [])).resolves.toBe('pt')
    mocks.page.lang = ''
    await expect(call('detectLanguage', [4])).resolves.toBe('und')
  })
})
