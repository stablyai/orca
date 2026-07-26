import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileLocaleProvider, useMobileLocale } from './mobile-locale-provider'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage
}))

function LocaleConsumer() {
  const { locale, setLocale } = useMobileLocale()
  return createElement('Locale', { locale, setLocale })
}

function providerElement() {
  return createElement(MobileLocaleProvider, null, createElement(LocaleConsumer))
}

describe('MobileLocaleProvider', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    asyncStorage.getItem.mockReset()
    asyncStorage.setItem.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('renders immediately while the persisted locale is loading', () => {
    asyncStorage.getItem.mockReturnValue(Promise.withResolvers<string>().promise)

    act(() => {
      renderer = create(providerElement())
    })

    expect(renderer?.root.findByType('Locale').props.locale).toBe('en')
  })

  it('does not overwrite a newly saved locale with a stale initial read', async () => {
    const initialRead = Promise.withResolvers<string>()
    asyncStorage.getItem.mockReturnValue(initialRead.promise)

    act(() => {
      renderer = create(providerElement())
    })
    const localeNode = renderer.root.findByType('Locale')

    await act(async () => {
      await localeNode.props.setLocale('zh-CN')
    })
    await act(async () => {
      initialRead.resolve('en')
      await initialRead.promise
    })

    expect(renderer.root.findByType('Locale').props.locale).toBe('zh-CN')
  })

  it('protects a same-locale selection while the initial read is pending', async () => {
    const initialRead = Promise.withResolvers<string>()
    const save = Promise.withResolvers<void>()
    asyncStorage.getItem.mockReturnValue(initialRead.promise)
    asyncStorage.setItem.mockReturnValue(save.promise)

    act(() => {
      renderer = create(providerElement())
    })
    const saveSelection = renderer.root.findByType('Locale').props.setLocale('en')

    await act(async () => {
      initialRead.resolve('zh-CN')
      await initialRead.promise
    })
    expect(renderer.root.findByType('Locale').props.locale).toBe('en')

    await act(async () => {
      save.resolve()
      await saveSelection
    })
  })
})
