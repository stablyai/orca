import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinTerminalThemePalette } from '../../../src/shared/terminal-themes'
import type { MobileTerminalTheme } from './terminal-webview-contract'

// Why: the hook transitively imports AsyncStorage at module scope.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined)
  }
}))

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

const restoreConsoleError = suppressReactTestRendererDeprecationWarning()

const hostTheme: MobileTerminalTheme = {
  mode: 'dark',
  theme: { background: '#101010', foreground: '#f0f0f0' }
}

// Why: the preference store is a module singleton, so every case needs a fresh graph.
async function mountHarness(stored: Record<string, string> = {}) {
  vi.resetModules()
  const storage = (await import('@react-native-async-storage/async-storage')).default
  vi.mocked(storage.getItem).mockImplementation(async (key: string) => stored[key] ?? null)
  const { saveMobileTerminalThemeSelection } = await import('../storage/terminal-theme-preference')
  const { useMobileTerminalTheme } = await import('./use-mobile-terminal-theme')
  const rendered: (MobileTerminalTheme | undefined)[] = []

  function Harness({ theme }: { theme: MobileTerminalTheme | undefined }) {
    rendered.push(useMobileTerminalTheme(theme))
    return null
  }

  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(Harness, { theme: hostTheme }))
  })
  return {
    rendered,
    saveMobileTerminalThemeSelection,
    rerender: async (theme: MobileTerminalTheme | undefined) => {
      await act(async () => {
        renderer.update(createElement(Harness, { theme }))
      })
    },
    unmount: async () => {
      await act(async () => {
        renderer.unmount()
      })
    }
  }
}

describe('useMobileTerminalTheme', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    restoreConsoleError()
  })

  it('passes the host palette through until a slot is chosen', async () => {
    const harness = await mountHarness()

    expect(harness.rendered.at(-1)).toBe(hostTheme)

    await harness.unmount()
  })

  it('adopts the persisted slot on a cold start, with no save', async () => {
    const harness = await mountHarness({ 'orca:terminalThemeDark': 'One Dark' })

    expect(harness.rendered.at(-1)).toEqual({
      mode: 'dark',
      theme: getBuiltinTerminalThemePalette('One Dark')
    })

    await harness.unmount()
  })

  it('repaints with the device slot without any navigation event', async () => {
    const harness = await mountHarness()

    await act(async () => {
      await harness.saveMobileTerminalThemeSelection({ dark: 'One Dark' })
    })

    expect(harness.rendered.at(-1)).toEqual({
      mode: 'dark',
      theme: getBuiltinTerminalThemePalette('One Dark')
    })

    await harness.unmount()
  })

  it('keeps the resolved identity across a re-render with an unchanged host theme', async () => {
    const harness = await mountHarness()
    await act(async () => {
      await harness.saveMobileTerminalThemeSelection({ dark: 'One Dark' })
    })
    const resolved = harness.rendered.at(-1)

    await harness.rerender(hostTheme)

    expect(harness.rendered.at(-1)).toBe(resolved)

    await harness.unmount()
  })

  it('stops receiving store updates after unmount', async () => {
    const harness = await mountHarness()
    await harness.unmount()
    const renderCount = harness.rendered.length

    await act(async () => {
      await harness.saveMobileTerminalThemeSelection({ dark: 'Nord' })
    })

    expect(harness.rendered).toHaveLength(renderCount)
  })
})
