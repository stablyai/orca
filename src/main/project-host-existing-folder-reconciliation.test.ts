import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../shared/execution-host'
import {
  didReconciliationChangeRepoIdentity,
  didReconciliationChangeStore,
  EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS,
  PROJECT_IDENTITY_MISMATCH_MESSAGE,
  PROJECT_IDENTITY_REMOTE_UNREADABLE_MESSAGE,
  PROJECT_IDENTITY_UNRESOLVED_MESSAGE,
  REPO_GITHUB_METADATA_OUTRANKS_PROJECT_MESSAGE
} from './project-host-existing-folder-reconciliation'
import {
  FORK_PROJECT_ID,
  forkIdentity,
  GHES_OTHER_URL,
  GHES_PROJECT_ID,
  ghesIdentity,
  GITHUB_SSH_ALIAS_URL,
  GITHUB_URL,
  identity,
  makeRepo,
  makeStore,
  makeWorktreeMeta,
  mockResolved,
  otherIdentity,
  reconcile,
  TEAM_PROJECT_ID,
  TEAM_SCP_URL,
  TEAM_SSH_URL,
  teamIdentity
} from './project-host-existing-folder-reconciliation-fixture'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

vi.mock('./repo-git-remote-identity', () => ({ probeGitRemoteIdentity: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reconcileExistingFolderProjectIdentity', () => {
  it('links a clone whose stored identity settled as no-remote', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    const result = await reconcile(store, imported, TEAM_PROJECT_ID)

    expect(result.setup.projectId).toBe(TEAM_PROJECT_ID)
    expect(result.project.id).toBe(TEAM_PROJECT_ID)
    expect(store.updateRepo.mock.calls[0]).toEqual([
      'repo-imported',
      { gitRemoteIdentity: teamIdentity }
    ])
    expect(store.updateRepo.mock.calls[1]).toEqual([
      'repo-imported',
      { projectHostSetupMethod: 'imported-existing-folder' }
    ])
    expect(probeGitRemoteIdentity).toHaveBeenCalledWith('/work/orca', null, {
      timeoutMs: EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS
    })
  })

  it('bounds the probe well inside the setup call it blocks', () => {
    // Awaited inline inside a setup call the renderer caps at 15 s, which also has to
    // cover `addRepo`'s own validation — so an unreachable remote must give up early.
    expect(EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS).toBe(3000)
  })

  it('links a clone whose identity was never probed', async () => {
    const imported = makeRepo()
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).resolves.toMatchObject({
      setup: { projectId: TEAM_PROJECT_ID }
    })
    expect(imported.gitRemoteIdentity).toEqual(teamIdentity)
  })

  it('treats scp-like and ssh:// remotes as the same project', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: identity('origin', TEAM_SSH_URL) }),
      imported
    ])
    mockResolved(teamIdentity)

    const result = await reconcile(store, imported, TEAM_PROJECT_ID)

    expect(result.setup.projectId).toBe(TEAM_PROJECT_ID)
    expect(imported.gitRemoteIdentity?.remoteUrl).toBe(TEAM_SCP_URL)
  })

  it('repairs a stale non-null identity from the current remote', async () => {
    const imported = makeRepo({ gitRemoteIdentity: otherIdentity })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    const result = await reconcile(store, imported, TEAM_PROJECT_ID)

    expect(result.setup.projectId).toBe(TEAM_PROJECT_ID)
    expect(imported.gitRemoteIdentity).toEqual(teamIdentity)
  })

  it('persists the matching fork remote instead of the primary remote', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: forkIdentity }),
      imported
    ])
    // A fork checkout's primary remote is `upstream`; persisting it would land the
    // repo in the upstream project instead of the fork the user selected.
    mockResolved(identity('upstream', TEAM_SCP_URL), forkIdentity)

    const result = await reconcile(store, imported, FORK_PROJECT_ID)

    expect(result.setup.projectId).toBe(FORK_PROJECT_ID)
    expect(imported.gitRemoteIdentity).toEqual(forkIdentity)
  })

  it('rejects and writes nothing when no probed remote matches', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(otherIdentity)

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(imported.gitRemoteIdentity).toBeNull()
    expect(imported.projectHostSetupMethod).toBeUndefined()
  })

  it('keeps a stale identity when git reports no remote', async () => {
    const imported = makeRepo({ gitRemoteIdentity: otherIdentity })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(imported.gitRemoteIdentity).toEqual(otherIdentity)
  })

  it('refuses the GitHub fallback over a settled remote that names another project', async () => {
    const imported = makeRepo({ gitRemoteIdentity: teamIdentity })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        gitRemoteIdentity: ghesIdentity,
        upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
      }),
      imported
    ])
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })

    // An unread git is no evidence: stamping the GHES identity here would leave the repo
    // holding a gitlab remote while claiming to be an Enterprise checkout, and the `null`
    // marker cannot be settled either — that would evict it from `TEAM_PROJECT_ID`.
    await expect(reconcile(store, imported, GHES_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(imported.gitRemoteIdentity).toEqual(teamIdentity)
    expect('upstream' in imported).toBe(false)
  })

  it('still runs the GitHub fallback when the unread repo names the project itself', async () => {
    // Same unread probe, but the stored remote is the project's own: the folder is not
    // claiming anywhere else, it is only missing the GitHub metadata §6 supplies.
    const imported = makeRepo({ gitRemoteIdentity: ghesIdentity })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        gitRemoteIdentity: ghesIdentity,
        upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
      }),
      imported
    ])
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })

    const result = await reconcile(store, imported, GHES_PROJECT_ID)

    expect(result.setup.projectId).toBe(GHES_PROJECT_ID)
    expect(store.updateRepo.mock.calls[0]).toEqual([
      'repo-imported',
      { upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' } }
    ])
  })

  it('does not settle the no-remote marker when the import is rejected', async () => {
    const imported = makeRepo()
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(imported.gitRemoteIdentity).toBeUndefined()
  })

  it('blames the unread remote, not the folder, when the probe fails', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_REMOTE_UNREADABLE_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('rejects when the selected project has no resolved identity of its own', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([makeRepo({ id: 'repo-host-a', gitRemoteIdentity: null }), imported])

    await expect(reconcile(store, imported, 'repo:repo-host-a')).rejects.toThrow(
      PROJECT_IDENTITY_UNRESOLVED_MESSAGE
    )
    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('rejects when the selected project no longer exists', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([imported])

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow('Project not found')
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('links an uncredentialed clone to a GHES project through the GitHub fallback', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        gitRemoteIdentity: ghesIdentity,
        upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
      }),
      imported
    ])
    mockResolved(ghesIdentity)

    const result = await reconcile(store, imported, GHES_PROJECT_ID)

    expect(result.setup.projectId).toBe(GHES_PROJECT_ID)
    expect(store.updateRepo.mock.calls[0]).toEqual([
      'repo-imported',
      {
        gitRemoteIdentity: ghesIdentity,
        upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
      }
    ])
  })

  it('links a GHES clone whose endpoint port only survives in the project identity', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    // The project key keeps the HTTPS endpoint port; the canonical remote key never
    // does, so a literal comparison of the two can never match the right folder. The
    // host is not spelled like GitHub, so only that literal key can carry the match.
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com:8443' }
      }),
      imported
    ])
    mockResolved(ghesIdentity)

    const result = await reconcile(store, imported, 'github:git.acme-corp.com:8443/acme/orca')

    expect(result.setup.projectId).toBe('github:git.acme-corp.com:8443/acme/orca')
    expect(imported.gitRemoteIdentity).toEqual(ghesIdentity)
    expect(imported.upstream).toEqual({
      owner: 'acme',
      repo: 'orca',
      host: 'git.acme-corp.com:8443'
    })
  })

  it('links a clone that reaches github.com through the ssh.github.com alias', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: identity('origin', GITHUB_URL) }),
      imported
    ])
    const aliased = identity('origin', GITHUB_SSH_ALIAS_URL)
    mockResolved(aliased)

    const result = await reconcile(store, imported, 'github:acme/orca')

    expect(result.setup.projectId).toBe('github:acme/orca')
    expect(imported.gitRemoteIdentity).toEqual(aliased)
  })

  it('rejects and unstamps when the store cannot persist the identity it was given', async () => {
    const imported = makeRepo({ kind: 'folder' })
    // A store that drops the Enterprise host lands the folder in the same-named
    // github.com project; the plan predicts from its own object and cannot see that.
    const store = makeStore(
      [
        makeRepo({
          id: 'repo-host-a',
          upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
        }),
        imported
      ],
      (updates) =>
        updates.upstream
          ? { ...updates, upstream: { owner: updates.upstream.owner, repo: updates.upstream.repo } }
          : updates
    )

    const before = structuredClone(imported)

    await expect(reconcile(store, imported, GHES_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    // Absent, not `null`: a `null` upstream reads as "already resolved" to the fork
    // backfill, so it would permanently suppress the enrichment this repo still needs.
    expect('upstream' in imported).toBe(false)
    expect(imported).toEqual(before)
  })

  it('leaves upstream absent when the rejected write never landed', async () => {
    const imported = makeRepo({ kind: 'folder' })
    // A store that drops the write outright has nothing to undo, and `null` is not a
    // free stand-in for absent: it reads as "resolved" to the fork-upstream backfill.
    const store = makeStore(
      [
        makeRepo({
          id: 'repo-host-a',
          upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
        }),
        imported
      ],
      ({ upstream: _dropped, ...rest }) => rest
    )
    const before = structuredClone(imported)

    await expect(reconcile(store, imported, GHES_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect('upstream' in imported).toBe(false)
    expect(imported).toEqual(before)
    // Nothing landed, so there is nothing to undo — the rollback must stay silent.
    expect(store.updateRepo).toHaveBeenCalledTimes(1)
    expect(store.restoreRepoIdentityFields).not.toHaveBeenCalled()
  })

  it('restores the previous remote identity when a rejected import already wrote one', async () => {
    const imported = makeRepo({ gitRemoteIdentity: forkIdentity })
    // A concurrent enrichment stamping GitHub metadata re-keys the repo out of the
    // generic project the write was aiming at, so the verification fails after the write.
    const store = makeStore(
      [makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }), imported],
      (updates) =>
        updates.gitRemoteIdentity
          ? { ...updates, upstream: { owner: 'acme', repo: 'orca' } }
          : updates
    )
    mockResolved(teamIdentity)
    const before = structuredClone(imported)

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    // The whole record, not just the field under test: the rollback has to undo the
    // collateral `upstream` the store's own writer added, or the repo stays re-keyed.
    expect(imported).toEqual(before)
  })

  it('restores the settled no-remote marker rather than clearing it to absent', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore(
      [makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }), imported],
      (updates) =>
        updates.gitRemoteIdentity
          ? { ...updates, upstream: { owner: 'acme', repo: 'orca' } }
          : updates
    )
    mockResolved(teamIdentity)
    const before = structuredClone(imported)

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(imported.gitRemoteIdentity).toBeNull()
    expect(imported).toEqual(before)
  })

  it('reports a rejection that already mutated the store', async () => {
    const imported = makeRepo({ gitRemoteIdentity: forkIdentity })
    const store = makeStore(
      [makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }), imported],
      (updates) =>
        updates.gitRemoteIdentity
          ? { ...updates, upstream: { owner: 'acme', repo: 'orca' } }
          : updates
    )
    mockResolved(teamIdentity)

    const error = await reconcile(store, imported, TEAM_PROJECT_ID).catch((thrown) => thrown)

    // The write and its rollback both landed, so every client still holds a stale record.
    expect(didReconciliationChangeStore(error)).toBe(true)
  })

  it('reports a rejection decided before any write', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(otherIdentity)

    const error = await reconcile(store, imported, TEAM_PROJECT_ID).catch((thrown) => thrown)

    expect(didReconciliationChangeStore(error)).toBe(false)
  })

  it('keeps an enrichment that landed while the probe was in flight', async () => {
    const stored = makeRepo()
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      stored
    ])
    // The add path hands back a detached record; planning re-reads the store so the
    // enrichment is part of the decision instead of something a rollback could undo.
    const handedBack = structuredClone(stored)
    vi.mocked(probeGitRemoteIdentity).mockImplementation(async () => {
      stored.upstream = { owner: 'acme', repo: 'orca' }
      return { status: 'resolved', identity: teamIdentity, remotes: [teamIdentity] }
    })

    // The enrichment's GitHub metadata outranks the generic project the user selected.
    await expect(reconcile(store, handedBack, TEAM_PROJECT_ID)).rejects.toThrow(
      REPO_GITHUB_METADATA_OUTRANKS_PROJECT_MESSAGE
    )
    expect(stored.upstream).toEqual({ owner: 'acme', repo: 'orca' })
    expect('gitRemoteIdentity' in stored).toBe(false)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(store.restoreRepoIdentityFields).not.toHaveBeenCalled()
  })

  it('writes the probe-confirmed identity when only the store record is behind', async () => {
    // The caller's view already matches the project but the store's record does not, so
    // planning from the handed-back record would "succeed" with nothing written and then
    // reject on a store that still keys the repo as `repo:<id>`.
    const stored = makeRepo()
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      stored
    ])
    mockResolved(teamIdentity)

    const result = await reconcile(
      store,
      makeRepo({ gitRemoteIdentity: teamIdentity }),
      TEAM_PROJECT_ID
    )

    expect(result.setup.projectId).toBe(TEAM_PROJECT_ID)
    expect(store.updateRepo.mock.calls[0]).toEqual([
      'repo-imported',
      { gitRemoteIdentity: teamIdentity }
    ])
    expect(stored.gitRemoteIdentity).toEqual(teamIdentity)
  })

  it('leaves the store untouched when a rejection had nothing to write', async () => {
    // The store's record already matches the project the probe confirms, so there is no
    // write to plan. A rollback here would be a mutation nothing announces.
    const stored = makeRepo({
      gitRemoteIdentity: teamIdentity,
      upstream: { owner: 'acme', repo: 'orca' }
    })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      stored
    ])
    mockResolved(teamIdentity)

    const error = await reconcile(store, structuredClone(stored), TEAM_PROJECT_ID).catch(
      (thrown) => thrown
    )

    expect(error).toHaveProperty('message', REPO_GITHUB_METADATA_OUTRANKS_PROJECT_MESSAGE)
    expect(didReconciliationChangeStore(error)).toBe(false)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(store.restoreRepoIdentityFields).not.toHaveBeenCalled()
  })

  it('remaps worktree meta when an identity repair re-keys the repo', async () => {
    const imported = makeRepo({ gitRemoteIdentity: otherIdentity })
    const store = makeStore(
      [makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }), imported],
      undefined,
      {
        'repo-imported::/work/orca-feature': makeWorktreeMeta({
          projectId: 'git:gitlab.example.com/other/orca',
          projectHostSetupId: 'git:gitlab.example.com/other/orca::local'
        }),
        'repo-other::/work/unrelated': makeWorktreeMeta({
          projectId: 'git:gitlab.example.com/other/orca',
          projectHostSetupId: 'git:gitlab.example.com/other/orca::local'
        })
      }
    )
    mockResolved(teamIdentity)

    const result = await reconcile(store, imported, TEAM_PROJECT_ID)

    expect(store.worktreeMeta['repo-imported::/work/orca-feature']).toMatchObject({
      projectId: TEAM_PROJECT_ID,
      projectHostSetupId: result.setup.id,
      hostId: result.setup.hostId
    })
    // Another repo's workspaces are not this repair's business, even under the same old id.
    expect(store.worktreeMeta['repo-other::/work/unrelated']?.projectId).toBe(
      'git:gitlab.example.com/other/orca'
    )
  })

  it('leaves an unstamped worktree meta row alone', async () => {
    const imported = makeRepo({ gitRemoteIdentity: otherIdentity })
    const store = makeStore(
      [makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }), imported],
      undefined,
      { 'repo-imported::/work/orca-feature': makeWorktreeMeta() }
    )
    mockResolved(teamIdentity)

    await reconcile(store, imported, TEAM_PROJECT_ID)

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not touch worktree meta when the project membership never moved', async () => {
    const imported = makeRepo({ gitRemoteIdentity: teamIdentity })
    const store = makeStore([imported], undefined, {
      'repo-imported::/work/orca-feature': makeWorktreeMeta({ projectId: TEAM_PROJECT_ID })
    })

    await reconcile(store, imported, TEAM_PROJECT_ID)

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not remap worktree meta when the import is rejected', async () => {
    const imported = makeRepo({ gitRemoteIdentity: otherIdentity })
    const store = makeStore(
      [makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }), imported],
      undefined,
      {
        'repo-imported::/work/orca-feature': makeWorktreeMeta({
          projectId: 'git:gitlab.example.com/other/orca'
        })
      }
    )
    mockResolved(forkIdentity)

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('reports whether reconciliation rewrote the repo identity', async () => {
    const before = makeRepo({ gitRemoteIdentity: null })

    expect(didReconciliationChangeRepoIdentity(before, { ...before })).toBe(false)
    expect(
      didReconciliationChangeRepoIdentity(before, { ...before, gitRemoteIdentity: teamIdentity })
    ).toBe(true)
    expect(
      didReconciliationChangeRepoIdentity(before, {
        ...before,
        upstream: { owner: 'acme', repo: 'orca' }
      })
    ).toBe(true)
  })

  it('keeps a generic git project apart from a case-variant path on the same host', async () => {
    // Generic git servers serve `Team/orca` and `team/orca` as different repositories.
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        gitRemoteIdentity: identity('origin', 'git@gitlab.example.com:Team/orca.git')
      }),
      imported
    ])
    mockResolved(teamIdentity)

    await expect(reconcile(store, imported, 'git:gitlab.example.com/Team/orca')).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('recognizes a folder by the project git key when the project is GitHub-keyed', async () => {
    // The project's own record carries GitHub metadata, so it keys `github:` — but it also
    // names the generic remote this folder has, and that git key is the only entry that can
    // recognize it. §6 then supplies the GitHub metadata the folder lacks.
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        upstream: { owner: 'acme', repo: 'orca' },
        gitRemoteIdentity: teamIdentity
      }),
      imported
    ])
    mockResolved(teamIdentity)

    const result = await reconcile(store, imported, 'github:acme/orca')

    expect(result.setup.projectId).toBe('github:acme/orca')
    expect(imported).toMatchObject({
      gitRemoteIdentity: teamIdentity,
      upstream: { owner: 'acme', repo: 'orca' }
    })
  })

  it('still compares that git key byte-for-byte, GitHub-keyed project or not', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        upstream: { owner: 'acme', repo: 'orca' },
        gitRemoteIdentity: identity('origin', 'git@gitlab.example.com:Team/orca.git')
      }),
      imported
    ])
    mockResolved(teamIdentity)

    await expect(reconcile(store, imported, 'github:acme/orca')).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('links a GHES clone whose provider slug differs only by case', async () => {
    // The provider key is lowercased on the way in, so the two spellings name one repo.
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        upstream: { owner: 'Acme', repo: 'Orca', host: 'git.acme-corp.com' }
      }),
      imported
    ])
    mockResolved(ghesIdentity)

    const result = await reconcile(store, imported, GHES_PROJECT_ID)

    expect(result.setup.projectId).toBe(GHES_PROJECT_ID)
    expect(imported.gitRemoteIdentity).toEqual(ghesIdentity)
  })

  it('does not rewrite an identity the probe confirms is already stored', async () => {
    const imported = makeRepo({ gitRemoteIdentity: ghesIdentity })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        gitRemoteIdentity: ghesIdentity,
        upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
      }),
      imported
    ])
    mockResolved(ghesIdentity)

    const result = await reconcile(store, imported, GHES_PROJECT_ID)

    expect(result.setup.projectId).toBe(GHES_PROJECT_ID)
    expect(store.updateRepo.mock.calls[0]).toEqual([
      'repo-imported',
      { upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' } }
    ])
  })

  it('rejects a conflicting remote before the GitHub fallback can run', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({
        id: 'repo-host-a',
        gitRemoteIdentity: ghesIdentity,
        upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' }
      }),
      imported
    ])
    mockResolved(identity('origin', GHES_OTHER_URL))

    await expect(reconcile(store, imported, GHES_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('rejects a generic project when the repo carries outranking GitHub metadata', async () => {
    const imported = makeRepo({ upstream: { owner: 'acme', repo: 'orca' } })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      REPO_GITHUB_METADATA_OUTRANKS_PROJECT_MESSAGE
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(imported.upstream).toEqual({ owner: 'acme', repo: 'orca' })
  })

  it('never probes a folder record and still allows the GitHub fallback', async () => {
    const imported = makeRepo({ kind: 'folder' })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', upstream: { owner: 'acme', repo: 'orca' } }),
      imported
    ])

    const result = await reconcile(store, imported, 'github:acme/orca')

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(result.setup.projectId).toBe('github:acme/orca')
    expect(store.updateRepo.mock.calls[0]).toEqual([
      'repo-imported',
      { upstream: { owner: 'acme', repo: 'orca' } }
    ])
  })

  it('rejects a folder record for a generic Git project without probing', async () => {
    const imported = makeRepo({ kind: 'folder' })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_MISMATCH_MESSAGE
    )
    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('does not probe a record owned by a different execution host', async () => {
    const imported = makeRepo({ connectionId: 'builder' })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      PROJECT_IDENTITY_REMOTE_UNREADABLE_MESSAGE
    )
    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('probes a locally owned record locally even when it names a connection', async () => {
    // `executionHostId` is the authority; routing by the stale `connectionId` would run
    // git on a different machine than the one the ownership check just cleared.
    const imported = makeRepo({ executionHostId: LOCAL_EXECUTION_HOST_ID, connectionId: 'builder' })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    await reconcile(store, imported, TEAM_PROJECT_ID)

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith('/work/orca', null, {
      timeoutMs: EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS
    })
  })

  it('probes an SSH-owned record through its own connection', async () => {
    const imported = makeRepo({ connectionId: 'builder', path: '/srv/orca' })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    const result = await reconcile(store, imported, TEAM_PROJECT_ID, {
      ownedExecutionHostId: toSshExecutionHostId('builder')
    })

    expect(result.setup.projectId).toBe(TEAM_PROJECT_ID)
    expect(probeGitRemoteIdentity).toHaveBeenCalledWith('/srv/orca', 'builder', {
      timeoutMs: EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS
    })
  })

  it('probes the SSH host named by executionHostId, not a divergent connectionId', async () => {
    // Both fields exist and disagree: routing by `connectionId` would run git on a machine
    // the ownership check never cleared. The host id is percent-encoded, so the target has
    // to be decoded out of it rather than sliced.
    const imported = makeRepo({
      executionHostId: toSshExecutionHostId('build box'),
      connectionId: 'other-host',
      path: '/srv/orca'
    })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    await reconcile(store, imported, TEAM_PROJECT_ID, {
      ownedExecutionHostId: toSshExecutionHostId('build box')
    })

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith('/srv/orca', 'build box', {
      timeoutMs: EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS
    })
  })

  it('does not probe an SSH-owned record from another SSH host', async () => {
    const imported = makeRepo({ connectionId: 'builder', path: '/srv/orca' })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])

    await expect(
      reconcile(store, imported, TEAM_PROJECT_ID, {
        ownedExecutionHostId: toSshExecutionHostId('other-host')
      })
    ).rejects.toThrow(PROJECT_IDENTITY_REMOTE_UNREADABLE_MESSAGE)
    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  })

  it('probes a runtime-owned record on its own filesystem', async () => {
    const imported = makeRepo({ executionHostId: 'runtime:env-1' })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)

    await reconcile(store, imported, TEAM_PROJECT_ID, { ownedExecutionHostId: 'runtime:env-1' })

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith('/work/orca', null, {
      timeoutMs: EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS
    })
  })

  it('writes only setup metadata when the repo already projects to the selected project', async () => {
    const imported = makeRepo({ gitRemoteIdentity: teamIdentity })
    const store = makeStore([imported])

    const result = await reconcile(store, imported, TEAM_PROJECT_ID, { setupMethod: 'cloned' })

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(store.updateRepo.mock.calls).toEqual([
      ['repo-imported', { projectHostSetupMethod: 'cloned' }]
    ])
    expect(result.setup.setupMethod).toBe('cloned')
  })

  it('throws the disappeared-record error when the repo vanishes mid-reconciliation', async () => {
    const imported = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore([
      makeRepo({ id: 'repo-host-a', gitRemoteIdentity: teamIdentity }),
      imported
    ])
    mockResolved(teamIdentity)
    store.updateRepo.mockReturnValue(null)

    await expect(reconcile(store, imported, TEAM_PROJECT_ID)).rejects.toThrow(
      'Project setup repo disappeared'
    )
  })
})
