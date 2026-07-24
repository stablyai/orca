import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isGitRepo, MAX_GIT_MARKER_FILE_BYTES } from './repo'

describe.sequential('Git marker fallback metadata bounds', () => {
  let root: string
  let originalPath: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-git-marker-bounds-'))
    originalPath = process.env.PATH
    process.env.PATH = ''
  })

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  })

  function writeOversizedSparseFile(filePath: string): void {
    writeFileSync(filePath, 'x')
    truncateSync(filePath, MAX_GIT_MARKER_FILE_BYTES + 1)
  }

  it('rejects an oversized .git pointer without loading it', () => {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout)
    writeOversizedSparseFile(join(checkout, '.git'))

    expect(isGitRepo(checkout)).toBe(false)
  })

  it('rejects an oversized linked-worktree commondir pointer', () => {
    const checkout = join(root, 'checkout')
    const adminDir = join(root, 'admin')
    mkdirSync(checkout)
    mkdirSync(adminDir)
    writeFileSync(join(checkout, '.git'), `gitdir: ${adminDir}\n`)
    writeFileSync(join(adminDir, 'HEAD'), 'ref: refs/heads/main\n')
    writeOversizedSparseFile(join(adminDir, 'commondir'))

    expect(isGitRepo(checkout)).toBe(false)
  })

  it('checks a bare marker without retaining an oversized config', () => {
    const bareRepo = join(root, 'bare.git')
    mkdirSync(join(bareRepo, 'objects'), { recursive: true })
    mkdirSync(join(bareRepo, 'refs'))
    writeFileSync(join(bareRepo, 'HEAD'), 'ref: refs/heads/main\n')
    writeOversizedSparseFile(join(bareRepo, 'config'))

    expect(isGitRepo(bareRepo)).toBe(true)
  })
})
