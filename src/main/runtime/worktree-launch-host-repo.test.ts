import { describe, expect, it } from 'vitest'
import { resolveWorktreeHostRouting, resolveWorktreeLaunchHost } from './worktree-launch-host-repo'

// Routing from an arbitrary repo-id row can spawn remote worktrees locally with an invalid cwd (#11163).
describe('resolveWorktreeLaunchHost', () => {
  const localRow = { id: 'shared', path: '/local/repo' }
  const sshRow = { id: 'shared', path: '/remote/repo', connectionId: 'ssh-b' }

  it('reports ambiguous when duplicate repo rows disagree about the owning host', () => {
    expect(resolveWorktreeLaunchHost([localRow, sshRow], { repoId: 'shared' })).toEqual({
      kind: 'ambiguous'
    })
  })

  it('resolves the row for the host the worktree names', () => {
    expect(
      resolveWorktreeLaunchHost([localRow, sshRow], { repoId: 'shared', hostId: 'ssh:ssh-b' })
    ).toEqual({ kind: 'resolved', repo: sshRow, connectionId: 'ssh-b' })
    expect(
      resolveWorktreeLaunchHost([localRow, sshRow], { repoId: 'shared', hostId: 'local' })
    ).toEqual({ kind: 'resolved', repo: localRow, connectionId: null })
  })

  // The workspace host controls routing and metadata; another host's same-id row proves neither.
  it('never hands a worktree a connection belonging to a different host', () => {
    const clientOwnedRow = { id: 'r', path: '/p', connectionId: 'ssh-client' }
    expect(
      resolveWorktreeLaunchHost([clientOwnedRow], { repoId: 'r', hostId: 'runtime:env-a' })
    ).toEqual({ kind: 'resolved', repo: null, connectionId: null })
    // Runtime-nested SSH targets cannot be dialled here; renderer routing uses the same resolution differently.
    const nestedRow = {
      id: 'r',
      path: '/p',
      connectionId: 'ssh-nested',
      executionHostId: 'runtime:env-a' as const
    }
    expect(
      resolveWorktreeLaunchHost([nestedRow], { repoId: 'r', hostId: 'runtime:env-a' })
    ).toEqual({ kind: 'resolved', repo: nestedRow, connectionId: null })
    expect(
      resolveWorktreeLaunchHost([{ id: 'r', path: '/p', connectionId: 'openclaw' }], {
        repoId: 'r',
        hostId: 'ssh:m4air'
      })
    ).toEqual({ kind: 'resolved', repo: null, connectionId: 'm4air' })
    expect(
      resolveWorktreeLaunchHost(
        [
          { id: 'r', path: '/p', connectionId: 'openclaw' },
          { id: 'r', path: '/q', connectionId: 'm4air' }
        ],
        { repoId: 'r', hostId: 'ssh:m4air' }
      )
    ).toEqual({
      kind: 'resolved',
      repo: { id: 'r', path: '/q', connectionId: 'm4air' },
      connectionId: 'm4air'
    })
    expect(
      resolveWorktreeLaunchHost([{ id: 'r', path: '/p', connectionId: 'openclaw' }], {
        repoId: 'r',
        hostId: 'local'
      })
    ).toEqual({ kind: 'resolved', repo: null, connectionId: null })
  })

  it('leaves a single unambiguous row alone', () => {
    expect(resolveWorktreeLaunchHost([sshRow], { repoId: 'shared' })).toEqual({
      kind: 'resolved',
      repo: sshRow,
      connectionId: 'ssh-b'
    })
    expect(resolveWorktreeLaunchHost([localRow], { repoId: 'shared' })).toEqual({
      kind: 'resolved',
      repo: localRow,
      connectionId: null
    })
    expect(resolveWorktreeLaunchHost([], { repoId: 'shared' })).toEqual({
      kind: 'resolved',
      repo: null,
      connectionId: null
    })
  })
})

// Git routing must distinguish local from runtime hosts, even though neither supplies a client-dialable SSH connection.
describe('resolveWorktreeHostRouting', () => {
  const runtimeRow = {
    id: 'r',
    path: '/p',
    connectionId: 'ssh-nested',
    executionHostId: 'runtime:env-a' as const
  }

  it('keeps `runtime:` distinct from `local` where the launch answer collapses them', () => {
    expect(
      resolveWorktreeHostRouting([runtimeRow], { repoId: 'r', hostId: 'runtime:env-a' })
    ).toEqual({ kind: 'resolved', hostId: 'runtime:env-a', repo: runtimeRow })
    expect(
      resolveWorktreeLaunchHost([runtimeRow], { repoId: 'r', hostId: 'runtime:env-a' })
    ).toEqual({ kind: 'resolved', repo: runtimeRow, connectionId: null })
  })

  it('answers the host the worktree names over a rival row on another ssh host', () => {
    const rows = [
      { id: 'r', path: '/p', connectionId: 'openclaw' },
      { id: 'r', path: '/q', connectionId: 'm4air' }
    ]
    expect(resolveWorktreeHostRouting(rows, { repoId: 'r', hostId: 'ssh:m4air' })).toEqual({
      kind: 'resolved',
      hostId: 'ssh:m4air',
      repo: rows[1]
    })
    expect(resolveWorktreeHostRouting([rows[0]], { repoId: 'r', hostId: 'ssh:m4air' })).toEqual({
      kind: 'resolved',
      hostId: 'ssh:m4air',
      repo: null
    })
  })

  it('separates "nobody carries this id" from "rival rows disagree"', () => {
    expect(resolveWorktreeHostRouting([], { repoId: 'r' })).toEqual({ kind: 'unowned' })
    expect(
      resolveWorktreeHostRouting(
        [
          { id: 'r', path: '/p' },
          { id: 'r', path: '/q', connectionId: 'm4air' }
        ],
        { repoId: 'r' }
      )
    ).toEqual({ kind: 'ambiguous' })
  })
})
