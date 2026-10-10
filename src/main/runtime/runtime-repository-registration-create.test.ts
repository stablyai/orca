/**
 * Pins the raw-first parent resolution of RuntimeRepositoryRegistrationController.create:
 * a picker-returned parent with a trailing space (legal POSIX name) must be used as
 * typed when it exists, with the trim kept only for typed typos (#25386).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { prepareLocalWorktreeRootForRepoMock, detectRepoIconAndUpstreamMock } = vi.hoisted(() => ({
  prepareLocalWorktreeRootForRepoMock: vi.fn(async () => undefined),
  detectRepoIconAndUpstreamMock: vi.fn(async () => ({}))
}))

vi.mock('../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: detectRepoIconAndUpstreamMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'

function makeController(): RuntimeRepositoryRegistrationController {
  return new RuntimeRepositoryRegistrationController({
    getStore: () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create() only reads the repo members stubbed here.
      ({
        getRepos: () => [],
        addRepo: () => undefined,
        getRepo: () => undefined,
        updateRepo: () => undefined
      }) as never,
    invalidateResolvedWorktrees: () => undefined,
    invalidateWorktreeScan: () => undefined,
    notifyReposChanged: () => undefined
  })
}

describe('RuntimeRepositoryRegistrationController.create parent resolution', () => {
  let base: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orca-repo-create-'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('creates inside a trailing-space parent that exists exactly as requested', async () => {
    const parent = join(base, 'cloud dir ')
    mkdirSync(parent)
    const result = await makeController().create(parent, 'kid', 'folder')
    expect('error' in result && result.error).toBeFalsy()
    if (!('error' in result)) {
      expect(result.repo.path).toBe(join(parent, 'kid'))
    }
  })

  it('falls back to the trimmed spelling when the raw parent does not exist', async () => {
    const requested = join(base, 'typo dir ')
    const result = await makeController().create(requested, 'kid', 'folder')
    expect('error' in result && result.error).toBeFalsy()
    if (!('error' in result)) {
      expect(result.repo.path).toBe(join(base, 'typo dir', 'kid'))
    }
  })

  it('surfaces a non-absent probe failure instead of creating at the trimmed spelling', async () => {
    const blocker = join(base, 'blocker')
    writeFileSync(blocker, 'a file, not a directory')
    const requested = join(blocker, 'cloud dir ')
    const result = await makeController().create(requested, 'kid', 'folder')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toMatch(/Cannot access parent directory/)
    }
  })
})
