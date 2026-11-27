import { mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})

import { readClaudeFolderLogin, readClaudeFolderLoginAsync } from './claude-account-folder'

const roots: string[] = []
afterEach(() => {
  vi.mocked(readFile).mockClear()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-account-folder-'))
  roots.push(root)
  return { root }
}

it.each(['sync', 'async'] as const)(
  'refreshes shared login identity after an equal-metadata local replacement primed by %s',
  async (mode) => {
    const { root } = fixture()
    const state = join(root, '.claude.json')
    const staged = join(root, '.claude.next.json')
    const stamp = new Date('2025-01-01T00:00:00Z')
    writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } }))
    utimesSync(state, stamp, stamp)
    const first =
      mode === 'sync' ? readClaudeFolderLogin(state) : await readClaudeFolderLoginAsync(state)
    expect(first?.email).toBe('a@example.test')
    writeFileSync(staged, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test' } }))
    utimesSync(staged, stamp, stamp)
    renameSync(staged, state)
    expect(readClaudeFolderLogin(state)?.email).toBe('b@example.test')
    expect((await readClaudeFolderLoginAsync(state))?.email).toBe('b@example.test')
  }
)

it.each(['sync', 'async', 'removed'] as const)(
  'keeps a newer %s observation after an older async read finishes',
  async (mode) => {
    const { root } = fixture()
    const state = join(root, '.claude.json')
    const staged = join(root, '.claude.next.json')
    const oldState = JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } })
    writeFileSync(state, oldState)
    const delivery = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    vi.mocked(readFile).mockImplementationOnce(() => {
      started.resolve()
      return delivery.promise
    })
    const older = readClaudeFolderLoginAsync(state)
    await started.promise
    if (mode === 'removed') {
      unlinkSync(state)
      expect(readClaudeFolderLogin(state)).toBeNull()
    } else {
      writeFileSync(staged, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test' } }))
      renameSync(staged, state)
      const newer =
        mode === 'sync' ? readClaudeFolderLogin(state) : await readClaudeFolderLoginAsync(state)
      expect(newer?.email).toBe('b@example.test')
    }
    delivery.resolve(oldState)
    expect((await older)?.email).toBe('a@example.test')
    if (mode === 'removed') {
      writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: 'c@example.test' } }))
      expect(readClaudeFolderLogin(state, 5_000)?.email).toBe('c@example.test')
    } else {
      expect(readClaudeFolderLogin(state, 5_000)?.email).toBe('b@example.test')
    }
  }
)

it('replaces an older synchronous observation with a newer async login', async () => {
  const { root } = fixture()
  const state = join(root, '.claude.json')
  writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } }))
  expect(readClaudeFolderLogin(state)?.email).toBe('a@example.test')
  writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test' } }))
  expect((await readClaudeFolderLoginAsync(state))?.email).toBe('b@example.test')
  expect(readClaudeFolderLogin(state, 5_000)?.email).toBe('b@example.test')
})
