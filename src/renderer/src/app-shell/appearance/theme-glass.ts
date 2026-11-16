import {
  PLUGIN_THEME_GLASS_DEFAULT_TINT,
  type PluginThemeBackground
} from '../../../../shared/plugins/artifacts/plugin-theme-background'
import { mix, type Rgba } from '../../../../shared/color/rgba-contrast'
import type { ThemeGlassBlurResult } from './theme-glass-blur-protocol'
import { readableGlassTint, type ThemeGlassSurface } from './theme-glass-tint'
import { browserColorProbe } from './plugin-theme-tokens'

const PROPERTIES = [
  '--orca-theme-glass-image',
  '--orca-theme-glass-size',
  '--orca-theme-glass-tint'
] as const

/** Each glass surface's color token (with main.css's fallback) and the text tokens drawn on it. */
const SURFACE_TOKENS: readonly { surface: readonly string[]; texts: readonly string[] }[] = [
  {
    surface: ['--worktree-sidebar'],
    texts: ['--worktree-sidebar-foreground', '--muted-foreground']
  },
  { surface: ['--sidebar'], texts: ['--sidebar-foreground', '--muted-foreground'] },
  { surface: ['--tab-bar', '--card'], texts: ['--foreground', '--muted-foreground'] },
  { surface: ['--card'], texts: ['--foreground', '--muted-foreground'] }
]

type BlurredImage = {
  url: string
  objectUrl: string
  width: number
  height: number
  backdrop: readonly Rgba[]
}

let blurred: BlurredImage | null = null
let blurring: string | null = null
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

async function blur(url: string): Promise<BlurredImage> {
  const image = new Image()
  // Why: an untagged cross-origin bitmap would taint the worker's canvas and block the read-back.
  image.crossOrigin = 'anonymous'
  image.src = url
  await image.decode()
  const bitmap = await createImageBitmap(image)
  // Why a worker: the blur and encode would otherwise hold the UI thread for a frame or more.
  const worker = new Worker(new URL('./theme-glass-blur.worker.ts', import.meta.url), {
    type: 'module'
  })
  try {
    const result = await new Promise<ThemeGlassBlurResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ThemeGlassBlurResult>) => resolve(event.data)
      worker.onerror = (event) => reject(new Error(event.message))
      worker.postMessage(bitmap, [bitmap])
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    const backdrop: Rgba[] = []
    for (let i = 0; i < result.samples.length; i += 4) {
      backdrop.push([result.samples[i], result.samples[i + 1], result.samples[i + 2], 1])
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

function paintedColor(computed: CSSStyleDeclaration, tokens: readonly string[]): Rgba | null {
  for (const token of tokens) {
    const value = computed.getPropertyValue(token).trim()
    if (value) {
      return browserColorProbe(value)
    }
  }
  return null
}

/** The theme's tint, raised until its chrome text reads over this image (see readableGlassTint). */
function glassTint(requested: number, image: BlurredImage, root: HTMLElement): number {
  const computed = getComputedStyle(root)
  const background = paintedColor(computed, ['--background'])
  const opacity = computed.getPropertyValue('--orca-theme-background-opacity').trim()
  const percent = opacity === '' ? 100 : Number(opacity) * 100
  // The body's veil sits between the image and the chrome, as main.css paints it.
  const backdrop = background
    ? image.backdrop.map((color) => mix(color, background, percent))
    : image.backdrop
  const surfaces = SURFACE_TOKENS.flatMap(({ surface, texts }): ThemeGlassSurface[] => {
    const color = paintedColor(computed, surface)
    const textColors = texts.map((token) => paintedColor(computed, [token]))
    return color && textColors.every(Boolean)
      ? [{ surface: color, texts: textColors.filter((text): text is Rgba => text !== null) }]
      : []
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
  root.style.setProperty('--orca-theme-glass-tint', tint.toFixed(2))
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
  if (blurring === url) {
    return
  }
  blurring = url
  void blur(url)
    .then(
      (image) => {
        if (wanted?.background.url !== url) {
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
    .finally(() => {
      if (blurring === url) {
        blurring = null
      }
    })
}
