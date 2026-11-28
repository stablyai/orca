import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import { resolveLocalFileRequestPath } from './local-file-access-resolution'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: empty store stub only supplies getRepos/getSettings for out-of-root user-file resolution.
const emptyStore = {
  getRepos: () => [],
  getSettings: () => ({})
} as unknown as RuntimeStore

describe('resolveLocalFileRequestPath home-relative user-file paths', () => {
  it('expands ~/ paths against the local user home directory for explicit user-file access', async () => {
    await expect(
      resolveLocalFileRequestPath('~/.zshrc', { kind: 'user-file' }, emptyStore)
    ).resolves.toBe(resolve(homedir(), '.zshrc'))
  })

  it('expands ~\\ paths against the local user home directory for explicit user-file access', async () => {
    await expect(
      resolveLocalFileRequestPath('~\\notes\\todo.md', { kind: 'user-file' }, emptyStore)
    ).resolves.toBe(resolve(homedir(), 'notes\\todo.md'))
  })

  it('preserves the home prefix when repeated separators follow ~/', async () => {
    await expect(
      resolveLocalFileRequestPath('~//notes.txt', { kind: 'user-file' }, emptyStore)
    ).resolves.toBe(resolve(homedir(), 'notes.txt'))
  })

  it('expands ~/ against homedir even when process.cwd() is inside a registered project root', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test stub supplies only getRepos/getSettings with cwd registered as a repo root.
    const cwdRegisteredStore = {
      getRepos: () => [{ path: process.cwd() }],
      getSettings: () => ({})
    } as unknown as RuntimeStore

    await expect(
      resolveLocalFileRequestPath('~/.zshrc', { kind: 'user-file' }, cwdRegisteredStore)
    ).resolves.toBe(resolve(homedir(), '.zshrc'))
  })

  it('still rejects bare ~ and ~user/ paths', async () => {
    await expect(
      resolveLocalFileRequestPath('~', { kind: 'user-file' }, emptyStore)
    ).rejects.toThrow(/absolute path/i)
    await expect(
      resolveLocalFileRequestPath('~alice/.zshrc', { kind: 'user-file' }, emptyStore)
    ).rejects.toThrow(/absolute path/i)
  })
})
