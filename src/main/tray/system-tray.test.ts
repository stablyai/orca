import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SystemTrayModule from './system-tray'

const {
  attentionImage,
  baseMacImage,
  composeAttentionMock,
  createAppIconImageMock,
  createFromPathMock,
  devBadgeImage,
  devBadgeRetinaImage,
  menuFromTemplateMock,
  nativeThemeMock,
  resizedImage,
  retinaMacImage,
  stampDevBadgeMock,
  themeState,
  tintedMacImage,
  tintTemplateMock,
  trayInstances
} = vi.hoisted(() => {
  const makeImage = (name: string) => ({
    name,
    addRepresentation: vi.fn(),
    getScaleFactors: vi.fn(() => [1, 2]),
    getSize: vi.fn(() => ({ width: 16, height: 16 })),
    setTemplateImage: vi.fn(),
    toBitmap: vi.fn(() => Buffer.alloc(16 * 16 * 4)),
    toDataURL: vi.fn(() => `data:image/png;base64,${name}`)
  })
  const resizedImage = makeImage('windows')
  const baseMacImage = makeImage('mac-base')
  const retinaMacImage = makeImage('mac-retina')
  const tintedMacImage = makeImage('mac-tinted')
  const attentionImage = makeImage('attention')
  const devBadgeImage = makeImage('dev-badge')
  const devBadgeRetinaImage = makeImage('dev-badge-retina')
  const themeState = { updatedListener: null as (() => void) | null }
  const nativeThemeMock = {
    shouldUseDarkColors: false,
    on: vi.fn((_event: string, listener: () => void) => {
      themeState.updatedListener = listener
    }),
    removeListener: vi.fn((_event: string, listener: () => void) => {
      if (themeState.updatedListener === listener) {
        themeState.updatedListener = null
      }
    })
  }
  return {
    attentionImage,
    baseMacImage,
    composeAttentionMock: vi.fn(() => attentionImage),
    createAppIconImageMock: vi.fn(),
    createFromPathMock: vi.fn(),
    devBadgeImage,
    devBadgeRetinaImage,
    menuFromTemplateMock: vi.fn((template: unknown) => ({ template })),
    nativeThemeMock,
    resizedImage,
    retinaMacImage,
    stampDevBadgeMock: vi.fn((_base: unknown, scaleFactor?: number) =>
      scaleFactor === 2 ? devBadgeRetinaImage : devBadgeImage
    ),
    themeState,
    tintedMacImage,
    tintTemplateMock: vi.fn(() => tintedMacImage),
    trayInstances: [] as FakeTray[]
  }
})

class FakeTray {
  setToolTip = vi.fn()
  setTitle = vi.fn()
  setContextMenu = vi.fn()
  setImage = vi.fn()
  on = vi.fn()
  destroy = vi.fn()
  isDestroyed = vi.fn(() => false)
  constructor(public readonly image: unknown) {
    trayInstances.push(this)
  }
}

vi.mock('electron', () => ({
  Tray: FakeTray,
  Menu: { buildFromTemplate: menuFromTemplateMock },
  nativeImage: { createFromPath: createFromPathMock },
  nativeTheme: nativeThemeMock
}))

vi.mock('../../../resources/tray/orca-menu-barTemplate.png?asset&asarUnpack', () => ({
  default: '/assets/orca-menu-barTemplate.png'
}))

vi.mock('../../../resources/tray/orca-menu-barTemplate@2x.png?asset&asarUnpack', () => ({
  default: '/assets/orca-menu-barTemplate@2x.png'
}))

vi.mock('../app-icon', () => ({
  createAppIconImage: createAppIconImageMock
}))

vi.mock('./tray-attention-icon', () => ({
  composeTrayAttentionIcon: composeAttentionMock,
  tintTrayTemplateForAttention: tintTemplateMock
}))

vi.mock('./tray-dev-badge', () => ({
  stampTrayDevBadge: stampDevBadgeMock
}))

type TrayModule = typeof SystemTrayModule
type MenuItem = { label?: string; type?: string; click?: () => void }

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

async function loadModule(): Promise<TrayModule> {
  vi.resetModules()
  return import('./system-tray')
}

function createOptions(
  overrides: { isDevInstance?: boolean; devInstanceLabel?: string | null } = {}
) {
  return {
    appIcon: 'classic',
    isDevInstance: overrides.isDevInstance ?? false,
    devInstanceLabel: overrides.devInstanceLabel ?? null,
    onOpen: vi.fn(),
    onOpenSettings: vi.fn(),
    onCheckForUpdates: vi.fn(),
    onQuit: vi.fn()
  }
}

function builtMenuItems(): MenuItem[] {
  return menuFromTemplateMock.mock.calls.at(-1)?.[0] as MenuItem[]
}

beforeEach(() => {
  trayInstances.length = 0
  menuFromTemplateMock.mockClear()
  composeAttentionMock.mockClear()
  tintTemplateMock.mockClear()
  createAppIconImageMock.mockReset()
  createAppIconImageMock.mockReturnValue({ resize: vi.fn(() => resizedImage) })
  createFromPathMock.mockReset()
  createFromPathMock.mockImplementation((path: string) =>
    path.includes('@2x') ? retinaMacImage : baseMacImage
  )
  stampDevBadgeMock.mockClear()
  stampDevBadgeMock.mockImplementation((_base: unknown, scaleFactor?: number) =>
    scaleFactor === 2 ? devBadgeRetinaImage : devBadgeImage
  )
  for (const image of [
    baseMacImage,
    retinaMacImage,
    tintedMacImage,
    attentionImage,
    devBadgeImage,
    devBadgeRetinaImage
  ]) {
    image.addRepresentation.mockClear()
    image.getScaleFactors.mockReset().mockReturnValue([1, 2])
    image.getSize.mockReset().mockReturnValue({ width: 16, height: 16 })
    image.setTemplateImage.mockClear()
    image.toBitmap.mockClear()
    image.toDataURL.mockClear().mockReturnValue(`data:image/png;base64,${image.name}`)
  }
  nativeThemeMock.shouldUseDarkColors = false
  nativeThemeMock.on.mockClear()
  nativeThemeMock.removeListener.mockClear()
  themeState.updatedListener = null
})

afterEach(() => {
  setPlatform(originalPlatform)
  vi.restoreAllMocks()
})

describe('createSystemTray', () => {
  it('keeps the Windows icon, Open/Quit menu, and left-click behavior', async () => {
    setPlatform('win32')
    const { createSystemTray } = await loadModule()
    const options = createOptions()

    createSystemTray(options)

    expect(trayInstances).toHaveLength(1)
    expect(trayInstances[0].image).toBe(resizedImage)
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Orca')
    expect(builtMenuItems().map((item) => item.label)).toEqual(['Open Orca', undefined, 'Quit'])
    const clickHandler = trayInstances[0].on.mock.calls.find((call) => call[0] === 'click')?.[1]
    expect(clickHandler).toBeTypeOf('function')

    builtMenuItems()[0].click?.()
    ;(clickHandler as () => void)()
    builtMenuItems()[2].click?.()
    expect(options.onOpen).toHaveBeenCalledTimes(2)
    expect(options.onQuit).toHaveBeenCalledOnce()
  })

  it('creates a macOS template status item with the full native menu', async () => {
    setPlatform('darwin')
    const { createSystemTray } = await loadModule()
    const options = createOptions()

    createSystemTray(options)

    expect(trayInstances).toHaveLength(1)
    expect(trayInstances[0].image).toBe(baseMacImage)
    expect(baseMacImage.setTemplateImage).toHaveBeenCalledWith(true)
    expect(baseMacImage.addRepresentation).toHaveBeenCalledWith({
      scaleFactor: 2,
      dataURL: 'data:image/png;base64,mac-retina'
    })
    expect(builtMenuItems().map((item) => item.label)).toEqual([
      'Open Orca',
      undefined,
      'Settings',
      'Check for Updates...',
      undefined,
      'Quit'
    ])
    expect(trayInstances[0].on).not.toHaveBeenCalled()
    expect(nativeThemeMock.on).toHaveBeenCalledWith('updated', expect.any(Function))

    for (const [label, callback] of [
      ['Open Orca', options.onOpen],
      ['Settings', options.onOpenSettings],
      ['Check for Updates...', options.onCheckForUpdates],
      ['Quit', options.onQuit]
    ] as const) {
      builtMenuItems()
        .find((item) => item.label === label)
        ?.click?.()
      expect(callback).toHaveBeenCalledOnce()
    }
  })

  it('does not create a blank macOS item when the template asset fails to load', async () => {
    setPlatform('darwin')
    baseMacImage.getSize.mockReturnValue({ width: 0, height: 0 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createSystemTray } = await loadModule()

    expect(createSystemTray(createOptions())).toBeNull()
    expect(trayInstances).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('[system-tray] macOS menu bar icon could not be loaded')
  })

  it('is idempotent and remains disabled on Linux', async () => {
    setPlatform('darwin')
    const { createSystemTray } = await loadModule()
    const options = createOptions()
    expect(createSystemTray(options)).toBe(createSystemTray(options))
    expect(trayInstances).toHaveLength(1)

    setPlatform('linux')
    const linuxModule = await loadModule()
    expect(linuxModule.createSystemTray(options)).toBeNull()
  })
})

describe('dev instance indicator', () => {
  it('stamps the DEV badge into the macOS template with a rebuilt Retina rep', async () => {
    setPlatform('darwin')
    const { createSystemTray } = await loadModule()

    createSystemTray(createOptions({ isDevInstance: true, devInstanceLabel: 'my-branch' }))

    expect(stampDevBadgeMock).toHaveBeenCalledWith(baseMacImage)
    expect(stampDevBadgeMock).toHaveBeenCalledWith(baseMacImage, 2)
    expect(devBadgeImage.addRepresentation).toHaveBeenCalledWith({
      scaleFactor: 2,
      dataURL: 'data:image/png;base64,dev-badge-retina'
    })
    expect(devBadgeImage.setTemplateImage).toHaveBeenCalledWith(true)
    expect(trayInstances[0].image).toBe(devBadgeImage)
    expect(trayInstances[0].setTitle).not.toHaveBeenCalled()
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Orca DEV (my-branch)')
    expect(builtMenuItems()[0]).toMatchObject({
      label: 'Orca DEV (my-branch)',
      enabled: false
    })
  })

  it('tints the badged image (not the plain one) for macOS attention', async () => {
    setPlatform('darwin')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray(createOptions({ isDevInstance: true, devInstanceLabel: 'my-branch' }))

    setTrayAttention(true)

    expect(tintTemplateMock).toHaveBeenCalledWith(devBadgeImage, false)
  })

  it('falls back to the plain icon when badge stamping fails', async () => {
    setPlatform('darwin')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stampDevBadgeMock.mockImplementation(() => {
      throw new Error('bitmap failure')
    })
    const { createSystemTray } = await loadModule()

    expect(createSystemTray(createOptions({ isDevInstance: true }))).not.toBeNull()
    expect(trayInstances[0].image).toBe(baseMacImage)
    expect(warn).toHaveBeenCalledWith(
      '[system-tray] dev badge could not be stamped; showing plain icon',
      expect.any(Error)
    )
  })

  it('omits the label suffix when the dev instance has none', async () => {
    setPlatform('darwin')
    const { createSystemTray } = await loadModule()

    createSystemTray(createOptions({ isDevInstance: true }))

    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Orca DEV')
    expect(builtMenuItems()[0]).toMatchObject({ label: 'Orca DEV', enabled: false })
  })

  it('keeps the DEV marker in the tooltip across the attention toggle', async () => {
    setPlatform('darwin')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray(createOptions({ isDevInstance: true, devInstanceLabel: 'my-branch' }))
    const created = trayInstances[0]
    created.setToolTip.mockClear()

    setTrayAttention(true)
    expect(created.setToolTip).toHaveBeenCalledWith('Orca DEV (my-branch) - activity waiting')
    setTrayAttention(false)
    expect(created.setToolTip).toHaveBeenLastCalledWith('Orca DEV (my-branch)')
  })

  it('marks the Windows tooltip without badging the icon', async () => {
    setPlatform('win32')
    const { createSystemTray } = await loadModule()

    createSystemTray(createOptions({ isDevInstance: true, devInstanceLabel: 'my-branch' }))

    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Orca DEV (my-branch)')
    expect(stampDevBadgeMock).not.toHaveBeenCalled()
    expect(builtMenuItems()[0]).toMatchObject({ label: 'Orca DEV (my-branch)', enabled: false })
  })

  it('adds no DEV marker for production instances', async () => {
    setPlatform('darwin')
    const { createSystemTray } = await loadModule()

    createSystemTray(createOptions())

    expect(stampDevBadgeMock).not.toHaveBeenCalled()
    expect(trayInstances[0].image).toBe(baseMacImage)
    expect(builtMenuItems()[0].label).toBe('Open Orca')
  })
})

describe('macOS visibility', () => {
  it('creates and destroys the item as the setting toggles', async () => {
    setPlatform('darwin')
    const { setMacMenuBarIconVisible } = await loadModule()
    const options = createOptions()

    expect(setMacMenuBarIconVisible(false, options)).toBeNull()
    expect(trayInstances).toHaveLength(0)
    expect(setMacMenuBarIconVisible(true, options)).not.toBeNull()
    expect(trayInstances).toHaveLength(1)

    setMacMenuBarIconVisible(false, options)
    setMacMenuBarIconVisible(false, options)
    expect(trayInstances[0].destroy).toHaveBeenCalledOnce()
  })
})

describe('setTrayAttention', () => {
  it('preserves the Windows attention swap behavior', async () => {
    setPlatform('win32')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray(createOptions())
    const created = trayInstances[0]
    created.setImage.mockClear()

    setTrayAttention(true)
    expect(composeAttentionMock).toHaveBeenCalledWith(resizedImage)
    expect(created.setImage).toHaveBeenCalledWith(attentionImage)
    setTrayAttention(false)
    expect(created.setImage).toHaveBeenLastCalledWith(resizedImage)
  })

  it('uses a literal theme-aware glyph for macOS attention, then restores template mode', async () => {
    setPlatform('darwin')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray(createOptions())
    const created = trayInstances[0]
    created.setImage.mockClear()
    created.setToolTip.mockClear()

    setTrayAttention(true)
    expect(tintTemplateMock).toHaveBeenCalledWith(baseMacImage, false)
    expect(composeAttentionMock).toHaveBeenCalledWith(tintedMacImage)
    // Why: the attention image is rebuilt from 1x pixels, so the @2x
    // representation must be re-added or the glyph blurs on Retina.
    expect(tintTemplateMock).toHaveBeenCalledWith(baseMacImage, false, 2)
    expect(attentionImage.addRepresentation).toHaveBeenCalledWith({
      scaleFactor: 2,
      dataURL: 'data:image/png;base64,attention'
    })
    expect(attentionImage.setTemplateImage).toHaveBeenCalledWith(false)
    expect(created.setImage).toHaveBeenCalledWith(attentionImage)
    expect(created.setToolTip).toHaveBeenCalledWith('Orca - activity waiting')

    setTrayAttention(false)
    expect(baseMacImage.setTemplateImage).toHaveBeenLastCalledWith(true)
    expect(created.setImage).toHaveBeenLastCalledWith(baseMacImage)
    expect(created.setToolTip).toHaveBeenLastCalledWith('Orca')
  })

  it('recomposes active macOS attention when the system appearance changes', async () => {
    setPlatform('darwin')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray(createOptions())
    setTrayAttention(true)
    tintTemplateMock.mockClear()
    nativeThemeMock.shouldUseDarkColors = true

    themeState.updatedListener?.()

    expect(tintTemplateMock).toHaveBeenCalledWith(baseMacImage, true)
  })

  it('reflects attention requested before deferred macOS creation', async () => {
    setPlatform('darwin')
    const { createSystemTray, setTrayAttention } = await loadModule()
    setTrayAttention(true)
    createSystemTray(createOptions())

    expect(trayInstances[0].setImage).toHaveBeenCalledWith(attentionImage)
  })

  it('ignores repeated same-state attention calls', async () => {
    setPlatform('win32')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray(createOptions())
    const created = trayInstances[0]
    created.setImage.mockClear()

    setTrayAttention(true)
    setTrayAttention(true)

    expect(created.setImage).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending attention dot across a macOS hide/show toggle', async () => {
    setPlatform('darwin')
    const { setMacMenuBarIconVisible, setTrayAttention } = await loadModule()
    const options = createOptions()
    setMacMenuBarIconVisible(true, options)
    setTrayAttention(true)

    setMacMenuBarIconVisible(false, options)
    setMacMenuBarIconVisible(true, options)

    expect(trayInstances).toHaveLength(2)
    expect(trayInstances[1].setImage).toHaveBeenCalledWith(attentionImage)
  })
})

describe('destroySystemTray', () => {
  it('destroys idempotently and removes the macOS appearance listener', async () => {
    setPlatform('darwin')
    const { createSystemTray, destroySystemTray } = await loadModule()
    createSystemTray(createOptions())
    const created = trayInstances[0]
    const listener = themeState.updatedListener

    destroySystemTray()
    destroySystemTray()

    expect(created.destroy).toHaveBeenCalledOnce()
    expect(nativeThemeMock.removeListener).toHaveBeenCalledWith('updated', listener)
  })
})

describe('macOS hardening', () => {
  it('warns but still creates the item when only the @2x asset fails to load', async () => {
    setPlatform('darwin')
    retinaMacImage.getSize.mockReturnValue({ width: 0, height: 0 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createSystemTray } = await loadModule()

    expect(createSystemTray(createOptions())).not.toBeNull()
    expect(trayInstances).toHaveLength(1)
    expect(baseMacImage.addRepresentation).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[system-tray] macOS retina menu bar icon could not be loaded'
    )
  })

  it('degrades to the plain icon instead of throwing when attention composition fails', async () => {
    setPlatform('darwin')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray(createOptions())
    const created = trayInstances[0]
    created.setImage.mockClear()
    composeAttentionMock.mockImplementationOnce(() => {
      throw new Error('native image failure')
    })

    expect(() => setTrayAttention(true)).not.toThrow()
    expect(created.setImage).toHaveBeenLastCalledWith(baseMacImage)
    expect(created.setToolTip).toHaveBeenLastCalledWith('Orca')
    expect(warn).toHaveBeenCalledWith(
      '[system-tray] macOS attention icon failed; showing plain icon',
      expect.any(Error)
    )
  })

  it('contains a throwing menu-item callback instead of crashing', async () => {
    setPlatform('darwin')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createSystemTray } = await loadModule()
    const options = createOptions()
    options.onOpenSettings.mockImplementation(() => {
      throw new Error('boom')
    })
    createSystemTray(options)

    const settingsItem = builtMenuItems().find((item) => item.label === 'Settings')
    expect(() => settingsItem?.click?.()).not.toThrow()
    expect(error).toHaveBeenCalledWith('[system-tray] menu action failed', expect.any(Error))
  })
})
