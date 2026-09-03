import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearClaudeStaleFallbackMark,
  hasClaudeStaleFallbackMark,
  markClaudeStaleFallbackPending
} from './claude-stale-fallback-marker'

describe('claude stale-fallback marker', () => {
  let accountDir: string
  let managedAuthPath: string

  beforeEach(() => {
    accountDir = mkdtempSync(join(tmpdir(), 'orca-stale-fallback-'))
    managedAuthPath = join(accountDir, 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
  })

  afterEach(() => {
    try {
      chmodSync(accountDir, 0o700)
    } catch {
      // best effort; the dir may already be gone
    }
    rmSync(accountDir, { recursive: true, force: true })
  })

  it('is absent until marked, and gone once cleared', () => {
    expect(hasClaudeStaleFallbackMark(managedAuthPath)).toBe(false)
    markClaudeStaleFallbackPending(managedAuthPath)
    expect(hasClaudeStaleFallbackMark(managedAuthPath)).toBe(true)
    clearClaudeStaleFallbackMark(managedAuthPath)
    expect(hasClaudeStaleFallbackMark(managedAuthPath)).toBe(false)
  })

  it('writes beside the auth dir, never inside it', () => {
    // That directory is the Claude CLI's own config dir. Orca reads it; it does not add files to
    // it, and a stray file there is visible to the CLI and to the user.
    markClaudeStaleFallbackPending(managedAuthPath)
    expect(readdirSync(managedAuthPath)).toEqual([])
    expect(readdirSync(accountDir)).toContain('claude-stale-fallback-v1.json')
  })

  it('survives a process restart, because it is on disk', () => {
    // The guarantee is "refuse the fallback until a clear succeeds, including after a restart".
    // An in-memory flag cannot deliver that: a crash between the Keychain write and the clear
    // would leave a spent token in the file with nothing recording that it must not be served.
    markClaudeStaleFallbackPending(managedAuthPath)
    const markerPath = join(accountDir, 'claude-stale-fallback-v1.json')
    expect(existsSync(markerPath)).toBe(true)
    // A fresh read with no in-process state still sees it.
    expect(hasClaudeStaleFallbackMark(managedAuthPath)).toBe(true)
  })

  it('treats an unreadable directory as marked, not as clear', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    // Fail closed: an unreadable metadata dir must not silently re-enable the fallback this
    // marker exists to suppress. Ablation: returning `false` from the catch turns this red.
    markClaudeStaleFallbackPending(managedAuthPath)
    chmodSync(accountDir, 0o000)
    expect(hasClaudeStaleFallbackMark(managedAuthPath)).toBe(true)
  })
})
