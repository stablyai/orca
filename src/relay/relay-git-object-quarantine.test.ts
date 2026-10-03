import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import { createRelayGitObjectQuarantine } from './relay-git-object-quarantine'

describe('createRelayGitObjectQuarantine', () => {
  let root: string
  let git: GitExec

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-relay-quarantine-')))
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    git = vi.fn(async () => ({ stdout: '.git\n', stderr: '' }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  const envSeenByGit = () => createRelayGitObjectQuarantine(git, root).run(async (env) => env)

  it('appends the real store to alternates the relay process hands Git', async () => {
    vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', '/shared/objects')

    const env = await envSeenByGit()

    expect(env?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe(
      `/shared/objects:${join(root, '.git', 'objects')}`
    )
  })

  it('runs unquarantined when the relay process hands Git its own object dir', async () => {
    vi.stubEnv('GIT_OBJECT_DIRECTORY', '/elsewhere/objects')

    await expect(envSeenByGit()).resolves.toBeUndefined()
  })
})
