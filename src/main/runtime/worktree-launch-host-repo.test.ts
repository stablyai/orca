import { describe, expect, it } from 'vitest'
import { resolveWorktreeHostRouting, resolveWorktreeLaunchHost } from './worktree-launch-host-repo'

// Why (#11163): the terminal launch scope read
// `store.getRepo(worktree.repoId)?.connectionId ?? null` — one spelling of one arbitrarily chosen
// row instead of the worktree's execution host. A remote worktree then spawns its PTY on the
// client with the remote cwd (`DaemonProtocolError: Working directory "…" does not exist`).
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

  // The settled rule: the execution host is authoritative, and a row on some *other* host is never
  // evidence about this one — not for the connection, and not for the metadata row either. This is
  // the question `getRepoSshConnectionId` and `getSshTargetIdForExecutionHost` once answered two
  // ways; they now compose, and `execution-host.test.ts` pins the composition.
  it('never hands a worktree a connection belonging to a different host', () => {
    const clientOwnedRow = { id: 'r', path: '/p', connectionId: 'ssh-client' }
    expect(
      resolveWorktreeLaunchHost([clientOwnedRow], { repoId: 'r', hostId: 'runtime:env-a' })
    ).toEqual({ kind: 'resolved', repo: null, connectionId: null })
    // Even the runtime host's *own* row contributes no PTY route: its nested target lives in that
    // machine's namespace, so spawning against it here would dial the wrong box. The renderer
    // reads the same resolution and does want that id — see execution-host.test.ts.
    const nestedRow = {
      id: 'r',
      path: '/p',
      connectionId: 'ssh-nested',
      executionHostId: 'runtime:env-a' as const
    }
    expect(
      resolveWorktreeLaunchHost([nestedRow], { repoId: 'r', hostId: 'runtime:env-a' })
    ).toEqual({ kind: 'resolved', repo: nestedRow, connectionId: null })
    // Two SSH hosts, one shared repo id: the worktree's own host wins outright.
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
    // A row declaring itself local hands out no SSH connection, whatever `connectionId` says.
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

// The same resolution answering "which host is this on" rather than "what may this client dial".
// The runtime Git target needs the first question, because `local` and `runtime:` are two different
// non-SSH answers and only one of them may run here.
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
    // Both answer "no connection this client may dial"; only the routing view says which host.
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
    // A row on some other host is not evidence about this one, so it contributes no metadata either.
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
