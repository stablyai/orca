// These selectors also reach worktree rm, so translate only with proof of the caller's distro.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { RuntimeClient } from './runtime-client'
import { normalizeWorktreeSelectorForCaller } from './selectors'

const UBUNTU = 'Ubuntu-24.04'
const DEBIAN = 'Debian'
const LINUX_PATH = '/home/neil/qa-repo'
const MOUNTED_PATH = '/mnt/c/Users/neil/qa-repo'

function uncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

function worktreeRecord(path: string): RuntimeWorktreeRecord {
  return { id: `repo::${path}`, path } as RuntimeWorktreeRecord
}

function makeClient(paths: readonly string[], isRemote = false) {
  const call = vi.fn(async (method: string) => {
    if (method !== 'worktree.list') {
      throw new Error(`unexpected method ${method}`)
    }
    return {
      result: { worktrees: paths.map(worktreeRecord), totalCount: paths.length, truncated: false }
    }
  })
  return { client: { isRemote, call } as unknown as RuntimeClient, call }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('normalizeWorktreeSelectorForCaller in a WSL shell (#16628)', () => {
  it('resolves a shared /mnt drive without requiring the caller distro', async () => {
    const storedPath = uncPath(UBUNTU, '/mnt/c/Users/neil/qa-repo')
    const { client } = makeClient([storedPath])

    await expect(
      normalizeWorktreeSelectorForCaller(`path:${MOUNTED_PATH}`, '/mnt/c/Users/neil', client)
    ).resolves.toBe(`path:${storedPath}`)
  })

  it.each([
    ['a backslash UNC registration', uncPath(UBUNTU, LINUX_PATH)],
    ['a forward-slash UNC registration', `//wsl.localhost/${UBUNTU}${LINUX_PATH}`],
    ['the wsl$ alias', `\\\\wsl$\\${UBUNTU}${LINUX_PATH.replace(/\//g, '\\')}`]
  ])('resolves the typed Linux path to %s', async (_label, storedPath) => {
    const { client } = makeClient([storedPath])

    await expect(
      normalizeWorktreeSelectorForCaller(
        `path:${LINUX_PATH}`,
        uncPath(UBUNTU, '/home/neil'),
        client
      )
    ).resolves.toBe(`path:${storedPath}`)
  })

  it('leaves the path alone when only another distro spells it', async () => {
    const { client } = makeClient([uncPath(UBUNTU, LINUX_PATH)])
    // Interop can forward WSL_DISTRO_NAME from a different distro than the cwd proves.
    vi.stubEnv('WSL_DISTRO_NAME', UBUNTU)

    await expect(
      normalizeWorktreeSelectorForCaller(
        `path:${LINUX_PATH}`,
        uncPath(DEBIAN, '/home/neil'),
        client
      )
    ).resolves.toBe(`path:${LINUX_PATH}`)
  })

  it('picks the caller-distro worktree when two distros spell the same Linux path', async () => {
    const { client } = makeClient([uncPath(UBUNTU, LINUX_PATH), uncPath(DEBIAN, LINUX_PATH)])

    await expect(
      normalizeWorktreeSelectorForCaller(
        `path:${LINUX_PATH}`,
        uncPath(DEBIAN, '/home/neil'),
        client
      )
    ).resolves.toBe(`path:${uncPath(DEBIAN, LINUX_PATH)}`)
  })

  it.each([
    ['a Linux-native cwd', '/home/neil', `path:${LINUX_PATH}`],
    ['a Windows drive cwd', 'C:\\Users\\neil', `path:${LINUX_PATH}`]
  ])('never lists worktrees for %s', async (_label, cwd, selector) => {
    const { client, call } = makeClient([uncPath(UBUNTU, LINUX_PATH)])
    vi.stubEnv('WSL_DISTRO_NAME', UBUNTU)

    await expect(normalizeWorktreeSelectorForCaller(selector, cwd, client)).resolves.toBe(selector)
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['a branch selector', 'branch:qa'],
    ['a relative path', 'path:qa-repo'],
    // A Linux filename containing a backslash cannot be represented as a UNC path.
    ['a UNC path selector', `path:${uncPath(UBUNTU, LINUX_PATH)}`],
    ['a Linux path containing a backslash', 'path:/home/neil/qa\\repo']
  ])('leaves %s untranslated', async (_label, selector) => {
    const { client, call } = makeClient([uncPath(UBUNTU, LINUX_PATH)])

    await expect(
      normalizeWorktreeSelectorForCaller(selector, uncPath(UBUNTU, '/home/neil'), client)
    ).resolves.toBe(selector)
    expect(call).not.toHaveBeenCalled()
  })

  it('leaves a remote runtime alone, whose worktrees the caller cwd cannot name', async () => {
    const { client, call } = makeClient([uncPath(UBUNTU, LINUX_PATH)], true)

    await expect(
      normalizeWorktreeSelectorForCaller(
        `path:${LINUX_PATH}`,
        uncPath(UBUNTU, '/home/neil'),
        client
      )
    ).resolves.toBe(`path:${LINUX_PATH}`)
    expect(call).not.toHaveBeenCalled()
  })
})
