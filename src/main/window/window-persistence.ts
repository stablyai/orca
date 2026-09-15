import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

export type WindowState = {
  windowId: number
  worktreeId: string
  x: number
  y: number
  width: number
  height: number
}

type Logger = Pick<Console, 'debug' | 'warn'>

const WINDOW_STATE_FILE = 'window-state.json'

/**
 * Save window state to persistence file in userData directory.
 * Creates parent directory if it doesn't exist.
 */
export async function saveWindowState(windows: WindowState[], logger?: Logger): Promise<void> {
  const userDataPath = app.getPath('userData')
  const filePath = join(userDataPath, WINDOW_STATE_FILE)

  try {
    await mkdir(userDataPath, { recursive: true })
    const json = JSON.stringify(windows, null, 2)
    await writeFile(filePath, json, 'utf-8')
  } catch (error) {
    throw new Error(`Failed to save window state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Load window state from persistence file.
 * Returns null if file doesn't exist.
 * Returns empty array if file is corrupted (with warning log).
 */
export async function loadWindowState(logger?: Logger): Promise<WindowState[] | null> {
  const userDataPath = app.getPath('userData')
  const filePath = join(userDataPath, WINDOW_STATE_FILE)

  try {
    const json = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(json)

    if (!Array.isArray(parsed)) {
      const log = logger ?? console
      log.warn('[window-persistence] window-state.json is not an array, returning empty array')
      return []
    }

    return parsed
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return null
    }

    if (error instanceof SyntaxError) {
      const log = logger ?? console
      log.warn('[window-persistence] window-state.json is corrupted, returning empty array', {
        error: error.message
      })
      return []
    }

    throw new Error(`Failed to load window state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Delete the window state persistence file.
 */
export async function clearWindowState(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const filePath = join(userDataPath, WINDOW_STATE_FILE)

  try {
    await unlink(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return
    }
    throw new Error(`Failed to clear window state: ${error instanceof Error ? error.message : String(error)}`)
  }
}
