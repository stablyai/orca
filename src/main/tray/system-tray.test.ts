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

vi.mock('../window/desktop-integration/app-icon', () => ({
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
type MenuItem = { id?: string; click?: () => void }

const macInstances: FakeMacTray[] = []
class FakeMacTray {
  setImage = vi.fn()
  setToolTip = vi.fn()
  setMenu = vi.fn<(items: MenuItem[]) => void>()
  destroy = vi.fn(() => Promise.resolve())
  isDestroyed = vi.fn(() => false)
  constructor() {
    macInstances.push(this)
  }
}
vi.mock('./mac-menu-bar-tray', () => ({
  MacMenuBarTray: FakeMacTray,
  waitForMacMenuBarRetirement: () => Promise.resolve()
}))

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
  vi.useFakeTimers()
  trayInstances.length = 0
  macInstances.length = 0
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('system tray ownership and actions', () => {
  it('keeps macOS native tray ownership outside main and routes every offered action', async () => {
    setPlatform('darwin')
    const { createSystemTray, destroySystemTray } = await loadModule()
    const options = { ...createOptions(), onQuitAndStopAllSessions: vi.fn() }
    createSystemTray(options)
    expect(trayInstances).toHaveLength(0)
    const menu = macInstances[0].setMenu.mock.calls.at(-1)?.[0] ?? []
    for (const [id, callback] of [
      ['open', options.onOpen],
      ['settings', options.onOpenSettings],
      ['updates', options.onCheckForUpdates],
      ['quit-completely', options.onQuitAndStopAllSessions],
      ['quit', options.onQuit]
    ] as const) {
      menu.find((item) => item.id === id)?.click?.()
      expect(callback).toHaveBeenCalledOnce()
    }
    await destroySystemTray()
  })

  it('keeps Windows native tray actions and left-click restore without a macOS helper', async () => {
    setPlatform('win32')
    const { createSystemTray, destroySystemTray } = await loadModule()
    const options = createOptions()
    createSystemTray(options)
    expect(macInstances).toHaveLength(0)
    const menu = builtMenuItems()
    menu.find((item) => item.id === 'open')?.click?.()
    const click = trayInstances[0].on.mock.calls.find((call) => call[0] === 'click')?.[1]
    click?.()
    menu.find((item) => item.id === 'quit')?.click?.()
    expect(options.onOpen).toHaveBeenCalledTimes(2)
    expect(options.onQuit).toHaveBeenCalledOnce()
    await destroySystemTray()
  })

  it('does not introduce a tray on Linux', async () => {
    setPlatform('linux')
    const { createSystemTray } = await loadModule()
    expect(createSystemTray(createOptions())).toBeNull()
    expect(macInstances).toHaveLength(0)
    expect(trayInstances).toHaveLength(0)
  })
})
