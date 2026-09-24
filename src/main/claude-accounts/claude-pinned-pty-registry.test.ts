import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _internals,
  attachClaudePinnedPtyPersistence,
  confirmSeededPinnedClaudePtys,
  countClaudePinnedAccountUsers,
  createClaudePinnedPtyFilePersistence,
  hasLivePinnedClaudePtys,
  hasSeededUnconfirmedPinnedClaudePtys,
  markPinnedClaudePtyExited,
  markPinnedClaudePtySpawned,
  onClaudePinnedAccountDrained,
  readClaudePinnedPtyRegistryFile,
  reserveClaudePinnedAccount,
  seedPinnedClaudePtysFromPersistence
} from './claude-pinned-pty-registry'

describe('Claude pinned PTY registry', () => {
  afterEach(() => {
    _internals.reset()
  })

  it('counts reservations and live PTYs per account and drains once both are gone', () => {
    const drained = vi.fn()
    onClaudePinnedAccountDrained(drained)
    const release = reserveClaudePinnedAccount('acct-b')
    markPinnedClaudePtySpawned('pty-1', 'acct-b')
    expect(countClaudePinnedAccountUsers('acct-b')).toBe(2)
    expect(countClaudePinnedAccountUsers('acct-c')).toBe(0)

    release()
    release()
    expect(countClaudePinnedAccountUsers('acct-b')).toBe(1)
    expect(drained).not.toHaveBeenCalled()

    markPinnedClaudePtyExited('pty-1')
    expect(hasLivePinnedClaudePtys('acct-b')).toBe(false)
    expect(drained).toHaveBeenCalledTimes(1)
    expect(drained).toHaveBeenCalledWith('acct-b')
  })

  it('ignores exits of PTYs it never pinned', () => {
    const drained = vi.fn()
    onClaudePinnedAccountDrained(drained)
    markPinnedClaudePtyExited('unrelated')
    expect(drained).not.toHaveBeenCalled()
  })

  it('keeps seeded PTYs guarding until the daemon proves them dead', () => {
    const drained = vi.fn()
    onClaudePinnedAccountDrained(drained)
    seedPinnedClaudePtysFromPersistence({ alive: 'acct-b', dead: 'acct-c' })
    expect(hasSeededUnconfirmedPinnedClaudePtys()).toBe(true)
    expect(hasLivePinnedClaudePtys('acct-c')).toBe(true)

    confirmSeededPinnedClaudePtys(['alive'])

    expect(hasSeededUnconfirmedPinnedClaudePtys()).toBe(false)
    expect(hasLivePinnedClaudePtys('acct-b')).toBe(true)
    expect(hasLivePinnedClaudePtys('acct-c')).toBe(false)
    expect(drained).toHaveBeenCalledExactlyOnceWith('acct-c')
  })

  it('persists the live map to disk and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-claude-pinned-'))
    try {
      const filePath = join(dir, 'claude-pinned-pane-accounts.json')
      attachClaudePinnedPtyPersistence(createClaudePinnedPtyFilePersistence(filePath))
      markPinnedClaudePtySpawned('pty-1', 'acct-b')
      markPinnedClaudePtySpawned('pty-2', 'acct-c')
      markPinnedClaudePtyExited('pty-2')

      expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
        version: 1,
        panes: { 'pty-1': 'acct-b' }
      })
      expect(readClaudePinnedPtyRegistryFile(filePath)).toEqual({ 'pty-1': 'acct-b' })

      writeFileSync(filePath, '{"panes":{"x":42,"y":"acct-d"}}')
      expect(readClaudePinnedPtyRegistryFile(filePath)).toEqual({ y: 'acct-d' })
      writeFileSync(filePath, 'not json')
      expect(readClaudePinnedPtyRegistryFile(filePath)).toEqual({})
      expect(readClaudePinnedPtyRegistryFile(join(dir, 'missing.json'))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never lets a persistence failure break a spawn or an exit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    attachClaudePinnedPtyPersistence({
      write: () => {
        throw new Error('disk full')
      }
    })
    expect(() => markPinnedClaudePtySpawned('pty-1', 'acct-b')).not.toThrow()
    expect(() => markPinnedClaudePtyExited('pty-1')).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
