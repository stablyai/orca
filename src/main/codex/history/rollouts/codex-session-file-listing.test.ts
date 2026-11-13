import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listCodexSessionJsonlFiles,
  listCodexSessionJsonlFilesIncrementally
} from './codex-session-file-listing'

let root: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-session-listing-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

async function collectListedFiles(rootPath: string): Promise<string[]> {
  const files: string[] = []
  for await (const filePath of listCodexSessionJsonlFilesIncrementally(rootPath, { yieldMs: 0 })) {
    files.push(filePath)
  }
  return files
}

describe('codex session directory listing', () => {
  it('treats a missing date directory as empty without warning', async () => {
    const files = await collectListedFiles(join(root, 'sessions', '2026', '11', '13'))

    expect(files).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('keeps warning when a directory cannot be read', async () => {
    const blockingFile = join(root, 'sessions')
    writeFileSync(blockingFile, 'not a directory')

    const files = await collectListedFiles(blockingFile)

    expect(files).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('treats a missing sync-scan root as empty without warning', () => {
    expect(listCodexSessionJsonlFiles(join(root, 'sessions'))).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
