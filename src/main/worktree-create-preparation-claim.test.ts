import { describe, expect, it } from 'vitest'
import {
  preparationPathKey,
  selectPreparationForCreate,
  type PreparationCandidate,
  type PreparationRequest
} from './worktree-create-preparation-claim'

function candidate(overrides: Partial<PreparationCandidate> = {}): PreparationCandidate {
  return {
    repoPathKey: '/repo',
    workspaceRootKey: '/workspace',
    wslDistro: '',
    baseBranch: 'origin/main',
    canonicalBase: 'refs/remotes/origin/main',
    createdAt: 1_000,
    ...overrides
  }
}

function request(overrides: Partial<PreparationRequest> = {}): PreparationRequest {
  return {
    repoPathKey: '/repo',
    workspaceRootKey: '/workspace',
    wslDistro: '',
    baseBranch: 'origin/main',
    canonicalBase: 'refs/remotes/origin/main',
    ...overrides
  }
}

describe('selectPreparationForCreate', () => {
  it('matches the identical base before any ref probe has run', () => {
    const selection = selectPreparationForCreate([candidate()], request({ canonicalBase: null }))

    expect(selection).toEqual({
      kind: 'exact',
      candidate: candidate(),
      canonicalBase: 'refs/remotes/origin/main'
    })
  })

  it('asks for a canonical base only when something is armed under another spelling', () => {
    expect(
      selectPreparationForCreate(
        [candidate()],
        request({ baseBranch: 'main', canonicalBase: null })
      )
    ).toEqual({ kind: 'needs-canonical-base' })
    // Nothing armed for this repo, so the create must not pay a probe to learn that.
    expect(
      selectPreparationForCreate([], request({ baseBranch: 'main', canonicalBase: null }))
    ).toEqual({ kind: 'miss', reason: 'none_armed' })
  })

  it('matches when the two sides spell the same ref differently', () => {
    const selection = selectPreparationForCreate(
      [candidate()],
      request({ baseBranch: 'refs/remotes/origin/main' })
    )

    expect(selection).toEqual({
      kind: 'exact',
      candidate: candidate(),
      canonicalBase: 'refs/remotes/origin/main'
    })
  })

  it('retargets a local base onto the armed remote-tracking base of the same branch', () => {
    const selection = selectPreparationForCreate(
      [candidate()],
      request({ baseBranch: 'main', canonicalBase: 'refs/heads/main' })
    )

    expect(selection).toEqual({
      kind: 'retarget',
      candidate: candidate(),
      canonicalBase: 'refs/heads/main'
    })
  })

  it('prefers the freshest armed entry when several share the family', () => {
    const older = candidate({ canonicalBase: 'refs/remotes/origin/main', createdAt: 1 })
    const newer = candidate({ canonicalBase: 'refs/remotes/upstream/main', createdAt: 2 })

    const selection = selectPreparationForCreate(
      [older, newer],
      request({ baseBranch: 'main', canonicalBase: 'refs/heads/main' })
    )

    expect(selection).toMatchObject({ kind: 'retarget', candidate: newer })
  })

  it('refuses to retarget onto a different branch', () => {
    const selection = selectPreparationForCreate(
      [candidate()],
      request({ baseBranch: 'origin/release', canonicalBase: 'refs/remotes/origin/release' })
    )

    expect(selection).toEqual({ kind: 'miss', reason: 'base_mismatch' })
  })

  it('refuses to retarget onto a bare commit id, whose divergence is unbounded', () => {
    const selection = selectPreparationForCreate(
      [candidate()],
      request({ baseBranch: '1f2e3d4c5b6a7988', canonicalBase: '1f2e3d4c5b6a7988' })
    )

    expect(selection).toEqual({ kind: 'miss', reason: 'base_mismatch' })
  })

  it('names the key field that disagreed', () => {
    expect(selectPreparationForCreate([], request())).toEqual({
      kind: 'miss',
      reason: 'none_armed'
    })
    // Something is warm, just not for this repo — the shape of a size-cap eviction.
    expect(
      selectPreparationForCreate([candidate()], request({ repoPathKey: '/other-repo' }))
    ).toEqual({ kind: 'miss', reason: 'repo_mismatch' })
    expect(selectPreparationForCreate([candidate()], request({ wslDistro: 'Ubuntu' }))).toEqual({
      kind: 'miss',
      reason: 'wsl_distro_mismatch'
    })
    expect(
      selectPreparationForCreate([candidate()], request({ workspaceRootKey: '/other' }))
    ).toEqual({ kind: 'miss', reason: 'workspace_root_mismatch' })
  })

  it('never crosses hosts to satisfy a family retarget', () => {
    const selection = selectPreparationForCreate(
      [candidate({ wslDistro: 'Ubuntu' })],
      request({ baseBranch: 'main', canonicalBase: 'refs/heads/main' })
    )

    expect(selection).toEqual({ kind: 'miss', reason: 'wsl_distro_mismatch' })
  })
})

describe('preparationPathKey', () => {
  it('normalizes a posix path without folding case', () => {
    expect(preparationPathKey('/workspace/./repo/')).toBe('/workspace/repo/')
    expect(preparationPathKey('/Workspace/Repo')).toBe('/Workspace/Repo')
  })

  it('folds case for Windows drive and UNC paths, which compare case-insensitively', () => {
    expect(preparationPathKey('C:\\Workspace\\Repo')).toBe('c:\\workspace\\repo')
    expect(preparationPathKey('\\\\wsl.localhost\\Ubuntu\\home\\jin')).toBe(
      '\\\\wsl.localhost\\ubuntu\\home\\jin'
    )
  })
})
