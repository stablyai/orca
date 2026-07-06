import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  canonicalizeLocalTerminalPath,
  localTerminalCwdCanonicalizer
} from './terminal-cwd-realpath'

describe('canonicalizeLocalTerminalPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-cwd-realpath-'))

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves symlinks to their target', () => {
    const outside = join(root, 'outside')
    const worktree = join(root, 'worktree')
    mkdirSync(outside)
    mkdirSync(worktree)
    const link = join(worktree, 'escape')
    symlinkSync(outside, link, 'dir')
    expect(canonicalizeLocalTerminalPath(link)).toBe(canonicalizeLocalTerminalPath(outside))
  })

  it('returns null for nonexistent paths', () => {
    expect(canonicalizeLocalTerminalPath(join(root, 'does-not-exist'))).toBeNull()
  })

  it('skips WSL UNC paths instead of touching the 9P share', () => {
    expect(canonicalizeLocalTerminalPath('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')).toBeNull()
    expect(canonicalizeLocalTerminalPath('//wsl$/Ubuntu/home/jin/repo')).toBeNull()
  })
})

describe('localTerminalCwdCanonicalizer', () => {
  it('is disabled for SSH connections and enabled locally', () => {
    expect(localTerminalCwdCanonicalizer('ssh-1')).toBeUndefined()
    expect(localTerminalCwdCanonicalizer(null)).toBe(canonicalizeLocalTerminalPath)
    expect(localTerminalCwdCanonicalizer(undefined)).toBe(canonicalizeLocalTerminalPath)
  })
})
