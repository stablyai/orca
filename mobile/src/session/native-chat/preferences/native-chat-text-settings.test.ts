import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NativeChatTextSettings from './native-chat-text-settings'

vi.mock('react-native', () => ({
  Dimensions: {
    get: () => ({ width: 393, height: 852 }),
    addEventListener: () => ({ remove: () => {} })
  },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: <T>(styles: T): T => styles }
}))

vi.mock('@react-native-async-storage/async-storage', async () => {
  const { createInMemoryAsyncStorage } =
    await import('../../../test-support/in-memory-async-storage')
  return { default: createInMemoryAsyncStorage() }
})

const KEY = 'orca:nativeChatText'

beforeEach(async () => {
  const { default: storage } = await import('@react-native-async-storage/async-storage')
  await storage.removeItem(KEY)
})

type Settings = typeof NativeChatTextSettings
/** What a build of any age can leave under the key; `v` and `font` are absent on some. */
type SavedText = { size: number; font?: string; lineSpacing: string; v?: number }

// Reopening resets module state while retaining storage within the same case.
async function open(saved?: SavedText) {
  vi.resetModules()
  const { default: storage } = await import('@react-native-async-storage/async-storage')
  if (saved !== undefined) {
    await storage.setItem(KEY, JSON.stringify(saved))
  }
  const mirrored = await import('../../../storage/mirrored-storage-keys')
  mirrored.retainMirroredStorage([KEY])
  const settings: Settings = await import('./native-chat-text-settings')
  // The same module registry as the store, so the probe and the store share one React.
  const { createElement } = await import('react')
  const { act, create } = await import('react-test-renderer')
  await settings.reloadNativeChatTextSettings()

  const shown = (): ReturnType<Settings['useNativeChatTextSettings']> => {
    let held: ReturnType<Settings['useNativeChatTextSettings']> | null = null
    function Probe(): null {
      held = settings.useNativeChatTextSettings()
      return null
    }
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(createElement(Probe))
    })
    act(() => renderer?.unmount())
    if (held === null) {
      throw new Error('probe did not render')
    }
    return held
  }

  return {
    settings,
    storage,
    fallbackFont: settings.defaultNativeChatTextSettings().font,
    shown,
    stored: async (): Promise<unknown> => {
      const raw = await storage.getItem(KEY)
      return raw === null ? null : JSON.parse(raw)
    },
    /** Another runtime (the app's Settings, or a page) wrote storage and the mirror told this one. */
    otherRuntimeWrites: async (value: SavedText) => {
      await act(async () => {
        mirrored.writeMirroredStorage(KEY, JSON.stringify(value))
        await Promise.resolve()
      })
    },
    /** Storage changed under this runtime, which rereads it when the shell republishes. */
    republished: async (value: SavedText | null) => {
      await (value === null ? storage.removeItem(KEY) : storage.setItem(KEY, JSON.stringify(value)))
      await act(() => settings.reloadNativeChatTextSettings())
    }
  }
}

describe('native chat text settings: font', () => {
  it('replies default to the system face', async () => {
    const page = await open()
    expect(page.fallbackFont).toBe('system')
    expect(page.shown().font).toBe('system')
  })

  it('a fresh install follows the default, and a size or spacing change does not save it as a pick', async () => {
    const page = await open()
    expect(page.shown().font).toBe(page.fallbackFont)

    await page.settings.updateNativeChatTextSettings({ size: 18 })
    await page.settings.updateNativeChatTextSettings({ lineSpacing: 'relaxed' })

    expect(await page.stored()).toEqual({ size: 18, lineSpacing: 'relaxed', v: 2 })
    expect(page.shown()).toMatchObject({ size: 18, font: page.fallbackFont })
  })

  it.each([
    [
      'older build System (unversioned)',
      { size: 14, font: 'system', lineSpacing: 'default' },
      'system'
    ],
    [
      'older build Serif (unversioned)',
      { size: 14, font: 'serif', lineSpacing: 'default' },
      'serif'
    ],
    ['older build Mono (unversioned)', { size: 14, font: 'mono', lineSpacing: 'default' }, 'mono'],
    ['versioned System', { size: 14, font: 'system', lineSpacing: 'default', v: 2 }, 'system'],
    ['versioned Serif', { size: 14, font: 'serif', lineSpacing: 'default', v: 2 }, 'serif'],
    ['versioned Mono', { size: 14, font: 'mono', lineSpacing: 'default', v: 2 }, 'mono']
  ])('honors a saved font: %s', async (_name, saved, expected) => {
    const page = await open(saved)
    expect(page.shown().font).toBe(expected)

    // A later size-only edit keeps the saved font as the pick.
    await page.settings.updateNativeChatTextSettings({ size: 16 })
    expect(await page.stored()).toEqual({ size: 16, font: expected, lineSpacing: 'default', v: 2 })
    expect(page.shown().font).toBe(expected)
  })

  it('falls back to the default for a missing or unknown saved font', async () => {
    const unknown = await open({ size: 15, font: 'comic', lineSpacing: 'default', v: 2 })
    expect(unknown.shown()).toMatchObject({ size: 15, font: unknown.fallbackFont })
    await unknown.settings.updateNativeChatTextSettings({ size: 16 })
    expect(await unknown.stored()).toEqual({ size: 16, lineSpacing: 'default', v: 2 })
  })

  it.each(['system', 'serif', 'mono'] as const)(
    'an explicit %s pick survives later size and spacing changes',
    async (picked) => {
      const page = await open()
      await page.settings.updateNativeChatTextSettings({ font: picked })
      await page.settings.updateNativeChatTextSettings({ size: 20 })
      await page.settings.updateNativeChatTextSettings({ lineSpacing: 'compact' })

      const saved = { size: 20, font: picked, lineSpacing: 'compact', v: 2 }
      expect(await page.stored()).toEqual(saved)

      const reopened = await open(saved)
      expect(reopened.shown().font).toBe(picked)
    }
  )

  it('reset clears the pick, and the next size change saves no font', async () => {
    const page = await open({ size: 18, font: 'mono', lineSpacing: 'relaxed', v: 2 })
    await page.settings.resetNativeChatTextSettings()
    expect(await page.stored()).toBeNull()
    expect(page.shown().font).toBe(page.fallbackFont)

    await page.settings.updateNativeChatTextSettings({ size: 15 })
    expect(await page.stored()).toEqual({ size: 15, lineSpacing: 'default', v: 2 })
  })

  it('follows a pick or reset made in the other runtime', async () => {
    const page = await open({ size: 14, lineSpacing: 'default', v: 2 })

    await page.otherRuntimeWrites({ size: 14, font: 'system', lineSpacing: 'default', v: 2 })
    expect(page.shown().font).toBe('system')
    await page.settings.updateNativeChatTextSettings({ size: 17 })
    expect(await page.stored()).toMatchObject({ font: 'system' })

    // A Settings reset elsewhere, republished to this page, drops the pick here too.
    await page.republished(null)
    expect(page.shown().font).toBe(page.fallbackFont)
    await page.settings.updateNativeChatTextSettings({ size: 15 })
    expect(await page.stored()).toEqual({ size: 15, lineSpacing: 'default', v: 2 })
  })

  it('a default-following save from the other runtime keeps this one on the default', async () => {
    const page = await open({ size: 14, font: 'mono', lineSpacing: 'default', v: 2 })
    await page.otherRuntimeWrites({ size: 19, lineSpacing: 'default', v: 2 })
    expect(page.shown()).toMatchObject({ size: 19, font: page.fallbackFont })
    await page.settings.updateNativeChatTextSettings({ lineSpacing: 'relaxed' })
    expect(await page.stored()).toEqual({ size: 19, lineSpacing: 'relaxed', v: 2 })
  })

  it('an older app saving a size reads its own default font back in as System (known limit)', async () => {
    // Older Settings parse a missing font as their default (System) and save the whole snapshot.
    const page = await open({ size: 14, lineSpacing: 'default', v: 2 })
    await page.otherRuntimeWrites({ size: 16, font: 'system', lineSpacing: 'default' })
    expect(page.shown().font).toBe('system')
  })

  // The page rereads storage when the app republishes it, which can happen while this page's own save is
  // still on its way to storage.
  it.each([
    ['a size change', { size: 18 }],
    ['a spacing change', { lineSpacing: 'relaxed' as const }]
  ])(
    'a reread that sees storage from before a pending pick keeps the pick, then %s saves it',
    async (_name, next) => {
      const page = await open({ size: 14, lineSpacing: 'default', v: 2 })
      const landing = holdNextWrite(page.storage)

      const pick = page.settings.updateNativeChatTextSettings({ font: 'mono' })
      const reread = page.settings.reloadNativeChatTextSettings()
      landing.release()
      await pick
      await reread

      expect(page.shown().font).toBe('mono')
      await page.settings.updateNativeChatTextSettings(next)
      expect(await page.stored()).toMatchObject({ font: 'mono' })
    }
  )

  it('a stale reread cannot undo a newer pick or a reset', async () => {
    const page = await open({ size: 14, lineSpacing: 'default', v: 2 })
    const first = holdNextWrite(page.storage)
    const mono = page.settings.updateNativeChatTextSettings({ font: 'mono' })
    const reread = page.settings.reloadNativeChatTextSettings()
    const serif = page.settings.updateNativeChatTextSettings({ font: 'serif' })
    first.release()
    await Promise.all([mono, reread, serif])
    expect(page.shown().font).toBe('serif')
    expect(await page.stored()).toMatchObject({ font: 'serif' })

    const second = holdNextWrite(page.storage)
    const pick = page.settings.updateNativeChatTextSettings({ font: 'mono' })
    const rereadAgain = page.settings.reloadNativeChatTextSettings()
    const reset = page.settings.resetNativeChatTextSettings()
    second.release()
    await Promise.all([pick, rereadAgain, reset])
    expect(await page.stored()).toBeNull()
    expect(page.shown().font).toBe(page.fallbackFont)
    await page.settings.updateNativeChatTextSettings({ size: 16 })
    expect(await page.stored()).toEqual({ size: 16, lineSpacing: 'default', v: 2 })
  })

  it('a failed save shows the font storage still holds', async () => {
    const page = await open({ size: 14, font: 'system', lineSpacing: 'default', v: 2 })
    vi.spyOn(page.storage, 'setItem').mockRejectedValueOnce(new Error('storage full'))

    await page.settings.updateNativeChatTextSettings({ font: 'mono' })
    await page.settings.reloadNativeChatTextSettings()

    expect(page.shown().font).toBe('system')
    await page.settings.updateNativeChatTextSettings({ size: 16 })
    expect(await page.stored()).toEqual({ size: 16, font: 'system', lineSpacing: 'default', v: 2 })
  })
})

/** Holds the next storage write until released, as a slow storage bridge would. */
function holdNextWrite(storage: { setItem: (key: string, value: string) => Promise<void> }): {
  release: () => void
} {
  const write = storage.setItem.bind(storage)
  let release = (): void => {}
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(storage, 'setItem').mockImplementationOnce(async (key, value) => {
    await opened
    await write(key, value)
  })
  return { release: () => release() }
}
