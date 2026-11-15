import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import {
  THEME_STUDIO_SPECIMEN_FAILED_TITLE,
  THEME_STUDIO_SPECIMEN_READY_TITLE,
  type ThemeStudioSpecimenRequest
} from '../../shared/theme-studio/theme-studio-specimen-request'

const PANEL = { width: 1200, height: 800 }
const RENDER_TIMEOUT_MS = 15_000

export type ThemeStudioSpecimenImage = { png: string; width: number; height: number }

const base64Url = (text: string): string =>
  Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Draws the specimen page (Orca's own components, painted per panel by the app's theme paint) in
 * a hidden window that is never shown or focused, captures it, and closes it. Nothing stays
 * running afterwards.
 */
export async function renderThemeStudioSpecimen(
  request: ThemeStudioSpecimenRequest
): Promise<ThemeStudioSpecimenImage> {
  const size = { width: PANEL.width * request.panels.length, height: PANEL.height }
  const window = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Why its own partition: the page never shares cookies or storage with the app.
      partition: 'theme-studio-specimen'
    }
  })
  const { webContents } = window
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => event.preventDefault())
  try {
    const drawn = new Promise<void>((resolve, reject) => {
      webContents.on('page-title-updated', (_event, title) => {
        if (title === THEME_STUDIO_SPECIMEN_READY_TITLE) {
          resolve()
        } else if (title === THEME_STUDIO_SPECIMEN_FAILED_TITLE) {
          reject(new Error('The theme specimen could not read its colors.'))
        }
      })
    })
    const hash = base64Url(JSON.stringify(request))
    const loaded =
      !app.isPackaged && process.env.ELECTRON_RENDERER_URL
        ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/theme-specimen.html#${hash}`)
        : window.loadFile(join(__dirname, '../renderer/theme-specimen.html'), { hash })
    // Why: after a timeout the window is destroyed and these reject with nobody listening.
    loaded.catch(() => undefined)
    drawn.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all([loaded, drawn]),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The theme specimen did not draw in time.')),
          RENDER_TIMEOUT_MS
        )
      })
    ]).finally(() => clearTimeout(timer))
    const image = await webContents.capturePage({ x: 0, y: 0, ...size })
    const sized = image.resize(size)
    return { png: sized.toPNG().toString('base64'), ...size }
  } finally {
    window.destroy()
  }
}
