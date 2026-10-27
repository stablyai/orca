import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findUnusableRendererRuntimeFile } from './windows-renderer-runtime-files'

describe('findUnusableRendererRuntimeFile', () => {
  let installDir: string
  let execPath: string

  beforeEach(() => {
    installDir = mkdtempSync(join(os.tmpdir(), 'orca-renderer-runtime-files-'))
    execPath = join(installDir, 'Orca.exe')
  })

  afterEach(() => {
    rmSync(installDir, { recursive: true, force: true })
  })

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
