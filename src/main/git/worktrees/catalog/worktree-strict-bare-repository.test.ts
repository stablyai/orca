import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorktrees } from './worktree-scan-cache'

const tempRoots: string[] = []
const STRICT_BARE_KEYS = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function withExplicitBareRepositoryPolicy<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(STRICT_BARE_KEYS.map((key) => [key, process.env[key]]))
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'safe.bareRepository'
  process.env.GIT_CONFIG_VALUE_0 = 'explicit'
  try {
    return await run()
  } finally {
    for (const key of STRICT_BARE_KEYS) {
      const value = previous[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('strict bare repository worktree list', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps the bare row when safe.bareRepository is explicit',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'orca-strict-bare-'))
      tempRoots.push(root)
      const requested = path.join(root, 'bare.git')
      execFileSync('git', ['init', '--bare', '--quiet', requested])
      const barePath = await realpath(requested)

      const open = await listWorktrees(barePath)
      expect(open).toEqual([
        expect.objectContaining({ path: barePath, isBare: true, isMainWorktree: true })
      ])

      const strict = await withExplicitBareRepositoryPolicy(() => listWorktrees(barePath))
      expect(strict).toEqual([
        expect.objectContaining({ path: barePath, isBare: true, isMainWorktree: true })
      ])
    }
  )
})
