import { BrowserWindow } from 'electron'
import {
  THEME_STUDIO_MODES,
  type ThemeStudioDraft,
  type ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import { themeSpecimenHtml } from '../../shared/theme-studio/theme-studio-specimen'

// Sizes the plugin page asks for: a 16:10 cover of 1600×1000 and screenshots of at least 1280×800.
const COVER = { width: 1600, height: 1000 }
const SCREENSHOT = { width: 1600, height: 1000 }
const RENDER_TIMEOUT_MS = 10_000

export type ThemeSpecimenImages = {
  cover: { mode: ThemeStudioMode; png: string }
  screenshots: { mode: ThemeStudioMode; png: string }[]
}

/** Draws one specimen page in a hidden window that is never shown or focused, and returns PNG. */
async function renderSpecimen(
  html: string,
  size: { width: number; height: number }
): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, images: false }
  })
  try {
    window.webContents.setZoomFactor(1)
    const loaded = window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      loaded,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The theme preview did not draw in time.')),
          RENDER_TIMEOUT_MS
        )
      })
    ]).finally(() => clearTimeout(timer))
    const image = await window.webContents.capturePage({ x: 0, y: 0, ...size })
    return image.resize(size).toPNG()
  } finally {
    window.destroy()
  }
}

/** The cover (dark when the theme has it) and one screenshot per mode, made from the theme alone. */
export async function renderThemeSpecimenImages(
  draft: ThemeStudioDraft
): Promise<ThemeSpecimenImages> {
  const modes = THEME_STUDIO_MODES.filter((mode) => draft[mode] !== null)
  const screenshots: ThemeSpecimenImages['screenshots'] = []
  for (const mode of modes) {
    const variant = draft[mode]
    if (variant) {
      const png = await renderSpecimen(
        themeSpecimenHtml(draft.name, mode, variant, SCREENSHOT),
        SCREENSHOT
      )
      screenshots.push({ mode, png: png.toString('base64') })
    }
  }
  const coverMode: ThemeStudioMode = draft.dark ? 'dark' : 'light'
  const coverVariant = draft[coverMode]
  if (!coverVariant) {
    throw new Error('The theme has no light or dark variant to draw.')
  }
  const cover = await renderSpecimen(
    themeSpecimenHtml(draft.name, coverMode, coverVariant, COVER),
    COVER
  )
  return { cover: { mode: coverMode, png: cover.toString('base64') }, screenshots }
}
