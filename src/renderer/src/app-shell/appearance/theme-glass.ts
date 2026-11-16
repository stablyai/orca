import {
  PLUGIN_THEME_GLASS_DEFAULT_TINT,
  type PluginThemeBackground
} from '../../../../shared/plugins/artifacts/plugin-theme-background'
import { mix, over, type Rgba } from '../../../../shared/color/rgba-contrast'
import {
  THEME_GLASS_SCALE,
  type ThemeGlassBlurRequest,
  type ThemeGlassBlurResult
} from './theme-glass-blur-protocol'
import {
  readableGlassTint,
  type ThemeGlassLayer,
  type ThemeGlassSurface,
  type ThemeGlassText
} from './theme-glass-tint'
import { browserColorProbe } from './plugin-theme-tokens'
import { CONTRAST_RULES, MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'

const PROPERTIES = [
  '--orca-theme-glass-image',
  '--orca-theme-glass-size',
  '--orca-theme-glass-tint'
] as const

/** Each `data-glass-surface` kind and its color token, first set wins (as main.css resolves it).
 *  `rules`: the surface is its token's own (sidebars), so that token's contrast rules apply; tab
 *  bars and the status bar only borrow `--card`'s color. */
const GLASS_SURFACES: readonly { kind: string; tokens: readonly string[]; rules: boolean }[] = [
  { kind: 'worktree-sidebar', tokens: ['--worktree-sidebar'], rules: true },
  { kind: 'sidebar', tokens: ['--sidebar'], rules: true },
  { kind: 'tab-bar', tokens: ['--tab-bar', '--card'], rules: false },
  { kind: 'titlebar', tokens: ['--card'], rules: false }
]
// Why: chrome draws plain and secondary text on every surface, beyond its own rule pairs.
const CHROME_TEXTS = ['--foreground', '--muted-foreground']

type BlurredImage = {
  url: string
  objectUrl: string
  width: number
  height: number
  backdrop: readonly Rgba[]
}

let blurred: BlurredImage | null = null
const blurring = new Map<string, Promise<BlurredImage>>()
// Why kept: a repaint while the blur runs must paint with the newest theme, and a switch must not paint the old image.
let wanted: { background: PluginThemeBackground; root: HTMLElement } | null = null

function release(): void {
  if (blurred) {
    URL.revokeObjectURL(blurred.objectUrl)
    blurred = null
  }
}

function clear(root: HTMLElement): void {
  for (const property of PROPERTIES) {
    root.style.removeProperty(property)
  }
  delete root.dataset.themeGlass
}

async function blur(url: string, tile: boolean): Promise<BlurredImage> {
  const image = new Image()
  // Why: an untagged cross-origin bitmap would taint the worker's canvas and block the read-back.
  image.crossOrigin = 'anonymous'
  image.src = url
  await image.decode()
  const bitmap = await createImageBitmap(image, {
    resizeWidth: Math.max(1, Math.round(image.naturalWidth / THEME_GLASS_SCALE)),
    resizeHeight: Math.max(1, Math.round(image.naturalHeight / THEME_GLASS_SCALE)),
    resizeQuality: 'medium'
  })
  // Why a worker: the blur and encode would otherwise hold the UI thread for a frame or more.
  const worker = new Worker(new URL('./theme-glass-blur.worker.ts', import.meta.url), {
    type: 'module'
  })
  try {
    const result = await new Promise<ThemeGlassBlurResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ThemeGlassBlurResult>) => resolve(event.data)
      worker.onerror = (event) => reject(new Error(event.message))
      worker.onmessageerror = () => reject(new Error('unreadable blur result'))
      const request: ThemeGlassBlurRequest = { bitmap, tile }
      worker.postMessage(request, [bitmap])
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    const backdrop: Rgba[] = []
    for (let i = 0; i < result.samples.length; i += 4) {
      const alpha = result.samples[i + 3] / 255
      backdrop.push([result.samples[i], result.samples[i + 1], result.samples[i + 2], alpha])
    }
    return {
      url,
      objectUrl: URL.createObjectURL(result.blob),
      width: image.naturalWidth,
      height: image.naturalHeight,
      backdrop
    }
  } finally {
    worker.terminate()
  }
}

function paintedColor(computed: CSSStyleDeclaration, token: string): Rgba | null {
  const value = computed.getPropertyValue(token).trim()
  return value ? browserColorProbe(value) : null
}

/** The texts drawn on a surface token and on the washes its contrast rules paint over it. */
function glassLayers(
  computed: CSSStyleDeclaration,
  token: string,
  rules: boolean
): ThemeGlassLayer[] {
  const texts = (pairs: readonly { text: string; min: number }[]): ThemeGlassText[] =>
    pairs.flatMap(({ text, min }) => {
      const color = paintedColor(computed, text)
      return color ? [{ color, min }] : []
    })
  const chrome = CHROME_TEXTS.map((text) => ({ text, min: MIN_TEXT_CONTRAST }))
  if (!rules) {
    return [{ wash: null, texts: texts(chrome) }]
  }
  const direct = CONTRAST_RULES.filter((rule) => rule.surface === token && !rule.over)
  return [
    { wash: null, texts: texts([...chrome, ...direct]) },
    ...CONTRAST_RULES.filter((rule) => rule.over === token).flatMap((rule): ThemeGlassLayer[] => {
      const wash = paintedColor(computed, rule.surface)
      return wash ? [{ wash, texts: texts([rule]) }] : []
    })
  ]
}

/** The theme's tint, raised until its chrome text reads over this image (see readableGlassTint). */
function glassTint(requested: number, image: BlurredImage, root: HTMLElement): number {
  const rootStyle = getComputedStyle(root)
  const background = paintedColor(rootStyle, '--background')
  if (!background) {
    return requested
  }
  const opacity = rootStyle.getPropertyValue('--orca-theme-background-opacity').trim()
  const percent = opacity === '' ? 100 : Number(opacity) * 100
  // Painted as main.css does: the image over the opaque base, then the body's veil.
  const backdrop = image.backdrop.map((color) => mix(over(color, background), background, percent))
  const surfaces = GLASS_SURFACES.flatMap(({ kind, tokens, rules }): ThemeGlassSurface[] => {
    // Why the element: a tinted left sidebar sets its own colors on it.
    const element = root.querySelector(`[data-glass-surface="${kind}"]`) ?? root
    const computed = getComputedStyle(element)
    const token = tokens.find((name) => paintedColor(computed, name))
    const surface = token ? paintedColor(computed, token) : null
    return token && surface ? [{ surface, layers: glassLayers(computed, token, rules) }] : []
  })
  return readableGlassTint(requested, backdrop, surfaces)
}

function paint(image: BlurredImage, background: PluginThemeBackground, root: HTMLElement): void {
  const tint = glassTint(background.glass?.tint ?? PLUGIN_THEME_GLASS_DEFAULT_TINT, image, root)
  if (tint >= 1) {
    clear(root)
    return
  }
  root.style.setProperty('--orca-theme-glass-image', `url(${JSON.stringify(image.objectUrl)})`)
  // Why natural size for tiles: the copy is smaller, and must repeat on the image's own grid.
  root.style.setProperty(
    '--orca-theme-glass-size',
    background.size === 'tile' ? `${image.width}px ${image.height}px` : (background.size ?? 'cover')
  )
  // Why round up: rounding down could paint below the tint that passed the contrast check.
  root.style.setProperty('--orca-theme-glass-tint', String(Math.ceil(tint * 100 - 1e-9) / 100))
  root.dataset.themeGlass = ''
}

/**
 * Paints the theme image's glass on the window chrome (see main.css), or clears it. Call after
 * applyThemeBackground and after each theme repaint: the tint depends on the painted colors.
 * The image is blurred once per URL, off the UI thread; a video theme keeps opaque chrome,
 * since its still would not match the playing frames.
 */
export function syncThemeGlass(
  background: PluginThemeBackground | null | undefined,
  root: HTMLElement = document.documentElement
): void {
  wanted = background?.glass && !background.videoUrl ? { background, root } : null
  if (!wanted) {
    clear(root)
    release()
    return
  }
  const { url } = wanted.background
  if (blurred?.url === url) {
    paint(blurred, wanted.background, root)
    return
  }
  clear(root)
  release()
  if (blurring.has(url)) {
    return
  }
  const pending = blur(url, wanted.background.size === 'tile')
  blurring.set(url, pending)
  void pending
    .then(
      (image) => {
        if (wanted?.background.url !== url || blurred) {
          URL.revokeObjectURL(image.objectUrl)
          return
        }
        blurred = image
        paint(image, wanted.background, wanted.root)
      },
      () => {
        // An image that cannot decode or blur leaves today's opaque chrome.
      }
    )
    .finally(() => blurring.delete(url))
}
