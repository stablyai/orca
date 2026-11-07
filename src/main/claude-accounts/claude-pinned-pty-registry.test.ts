import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _internals,
  attachClaudePinnedPtyPersistence,
  confirmSeededPinnedClaudePtys,
  createClaudePinnedPtyFilePersistence,
  getPinnedClaudeAccountIdForPty,
  hasSeededUnconfirmedPinnedClaudePtys,
  markPinnedClaudePtyExited,
  markPinnedClaudePtySpawned,
  readClaudePinnedPtyRegistryFile,
  seedPinnedClaudePtysFromPersistence
} from './claude-pinned-pty-registry'

describe('Claude pinned PTY registry', () => {
  afterEach(() => {
    _internals.reset()
  })

  it('names a pinned PTY until it exits, persisting each change', () => {
    const write = vi.fn()
    attachClaudePinnedPtyPersistence({ write })

    markPinnedClaudePtySpawned('pty-1', 'acct-1')
    expect(getPinnedClaudeAccountIdForPty('pty-1')).toBe('acct-1')
    expect(write).toHaveBeenLastCalledWith({ 'pty-1': 'acct-1' })

    markPinnedClaudePtyExited('pty-1')
    expect(getPinnedClaudeAccountIdForPty('pty-1')).toBeUndefined()
    expect(write).toHaveBeenLastCalledWith({})

    markPinnedClaudePtyExited('unpinned-pty')
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('keeps restored PTYs the daemon still runs and drops the rest', () => {
    seedPinnedClaudePtysFromPersistence({ alive: 'acct-1', dead: 'acct-2' })
    expect(hasSeededUnconfirmedPinnedClaudePtys()).toBe(true)

    confirmSeededPinnedClaudePtys(['alive'])

    expect(getPinnedClaudeAccountIdForPty('alive')).toBe('acct-1')
    expect(getPinnedClaudeAccountIdForPty('dead')).toBeUndefined()
    expect(hasSeededUnconfirmedPinnedClaudePtys()).toBe(false)
  })

  it('round-trips the registry file and ignores malformed entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-pinned-pty-'))
    try {
      const filePath = join(dir, 'claude-pinned-pane-accounts.json')
      createClaudePinnedPtyFilePersistence(filePath).write({ 'pty-1': 'acct-1', 'pty-2': '' })

      expect(readClaudePinnedPtyRegistryFile(filePath)).toEqual({ 'pty-1': 'acct-1' })
      expect(readClaudePinnedPtyRegistryFile(join(dir, 'missing.json'))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
