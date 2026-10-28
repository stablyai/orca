import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getStoreGitHubParticipants } from './github-participant-store'
import { readSharedGitHubCache } from './github-participant-shared-cache'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('shared GitHub cache with participants', () => {
  it('hides existing cache entries as soon as participant mode is enabled', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-participant-cache-'))
    directories.push(directory)
    const cache = { pr: { 'repo::main': { data: null, fetchedAt: 123 } }, issue: {} }
    const store = { getProfileStorageDirectory: () => directory, getGitHubCache: () => cache }
    const registry = getStoreGitHubParticipants(store)
    expect(readSharedGitHubCache(store)).toEqual(cache)
    registry?.setRepoEnabled('repo', true)
    expect(readSharedGitHubCache(store)).toEqual({ pr: {}, issue: {} })
    registry?.setRepoEnabled('repo', false)
    expect(readSharedGitHubCache(store)).toEqual(cache)
  })
})
