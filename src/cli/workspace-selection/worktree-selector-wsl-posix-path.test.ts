// These selectors also reach worktree rm, so translate only with proof of the caller's distro.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-worktree-contracts'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { normalizeWorktreeSelectorForCaller } from './workspace-selector'

const UBUNTU = 'Ubuntu-24.04'
const DEBIAN = 'Debian'
const LINUX_PATH = '/home/neil/qa-repo'

function uncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

function worktreeRecord(path: string): RuntimeWorktreeRecord {
  return { id: `repo::${path}`, path } as RuntimeWorktreeRecord
}

function makeClient(paths: readonly string[], isRemote = false, folderPaths: string[] = []) {
  const call = vi.fn(async (method: string) => {
    if (method === 'worktree.show') {
      // The runtime matcher is not under test here.
      throw new RuntimeClientError('selector_not_found', 'selector_not_found')
    }
    if (method === 'folderWorkspace.list') {
      return {
        result: { folderWorkspaces: folderPaths.map((folderPath) => ({ id: 'hub', folderPath })) }
      }
    }
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

  it("translates a folder workspace's Linux path in the caller's distro only", async () => {
    const { client } = makeClient([], false, [
      uncPath(UBUNTU, LINUX_PATH),
      uncPath(DEBIAN, LINUX_PATH)
    ])

    await expect(
      normalizeWorktreeSelectorForCaller(
        `path:${LINUX_PATH}`,
        uncPath(DEBIAN, '/home/neil'),
        client
      )
    ).resolves.toBe(`path:${uncPath(DEBIAN, LINUX_PATH)}`)
  })
})
