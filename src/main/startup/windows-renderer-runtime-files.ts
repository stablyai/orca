import { app } from 'electron'
import { closeSync, fstatSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { handleMainProcessPreflightFailure } from './main-process-preflight-failure'

/** Every renderer delay-loads this at child init; without it each one dies with 0x80000003 before any page loads. */
const RENDERER_RUNTIME_FILES = ['ffmpeg.dll'] as const

function isReadableNonEmptyFile(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    return fstatSync(fd).size > 0
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** First renderer runtime file beside the exe that is missing, empty, or locked, as an unfinished update leaves it. */
export function findUnusableRendererRuntimeFile(execPath: string): string | null {
  const exeDir = dirname(execPath)
  return RENDERER_RUNTIME_FILES.find((name) => !isReadableNonEmptyFile(join(exeDir, name))) ?? null
}

/** False once it has told the user to let an unfinished update complete; exiting also releases the installer's files. */
export function ensureWindowsRendererRuntimeFiles(isServeMode: boolean): boolean {
  if (process.platform !== 'win32' || !app.isPackaged || isServeMode) {
    return true
  }
  const fileName = findUnusableRendererRuntimeFile(process.execPath)
  if (!fileName) {
    return true
  }
  const message =
    `Orca's installation is incomplete: ${fileName} is missing or in use. ` +
    'If Orca is updating, wait for the installer to finish; it reopens Orca. ' +
    'Otherwise, reinstall Orca.'
  console.error(`[startup] ${message}`)
  handleMainProcessPreflightFailure(new Error(message))
  return false
}
