import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { electronApp, handleFailure } = vi.hoisted(() => ({
  electronApp: { isPackaged: true },
  handleFailure: vi.fn()
}))

vi.mock('electron', () => ({ app: electronApp }))
vi.mock('./main-process-preflight-failure', () => ({
  handleMainProcessPreflightFailure: handleFailure
}))

import {
  ensureWindowsRendererRuntimeFiles,
  findUnusableRendererRuntimeFile
} from './windows-renderer-runtime-files'

let installDir: string
let execPath: string

beforeEach(() => {
  installDir = mkdtempSync(join(os.tmpdir(), 'orca-renderer-runtime-files-'))
  execPath = join(installDir, 'Orca.exe')
})

afterEach(() => {
  rmSync(installDir, { recursive: true, force: true })
})

describe('findUnusableRendererRuntimeFile', () => {
  it('accepts a complete install', () => {
    writeFileSync(join(installDir, 'ffmpeg.dll'), 'MZ')
    expect(findUnusableRendererRuntimeFile(execPath)).toBeNull()
  })

  it('reports a DLL an unfinished update has not written yet', () => {
    expect(findUnusableRendererRuntimeFile(execPath)).toBe('ffmpeg.dll')
  })

  it('reports a DLL that is still empty', () => {
    writeFileSync(join(installDir, 'ffmpeg.dll'), '')
    expect(findUnusableRendererRuntimeFile(execPath)).toBe('ffmpeg.dll')
  })
})

describe('ensureWindowsRendererRuntimeFiles', () => {
  const originalPlatform = process.platform
  const originalExecPath = process.execPath

  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  beforeEach(() => {
    handleFailure.mockReset()
    electronApp.isPackaged = true
    setPlatform('win32')
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
    vi.restoreAllMocks()
  })

  it('fails the preflight with an explanation when ffmpeg.dll is missing', () => {
    expect(ensureWindowsRendererRuntimeFiles(false)).toBe(false)
    expect(handleFailure).toHaveBeenCalledTimes(1)
    expect(String(handleFailure.mock.calls[0][0])).toContain(
      'ffmpeg.dll is missing, empty, or in use'
    )
  })

  it('passes a complete packaged install', () => {
    writeFileSync(join(installDir, 'ffmpeg.dll'), 'MZ')
    expect(ensureWindowsRendererRuntimeFiles(false)).toBe(true)
    expect(handleFailure).not.toHaveBeenCalled()
  })

  it('skips non-Windows hosts', () => {
    setPlatform('darwin')
    expect(ensureWindowsRendererRuntimeFiles(false)).toBe(true)
    expect(handleFailure).not.toHaveBeenCalled()
  })

  it('skips unpackaged dev runs', () => {
    electronApp.isPackaged = false
    expect(ensureWindowsRendererRuntimeFiles(false)).toBe(true)
    expect(handleFailure).not.toHaveBeenCalled()
  })

  it('skips serve mode, which never opens a renderer window', () => {
    expect(ensureWindowsRendererRuntimeFiles(true)).toBe(true)
    expect(handleFailure).not.toHaveBeenCalled()
  })
})
