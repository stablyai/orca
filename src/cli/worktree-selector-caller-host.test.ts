/**
 * #21210: several SSH hosts hold a worktree of one repo at the same path. A CLI on host D must
 * resolve `current` (and a pane's forwarded worktree id) to host D's row, never another host's twin.
 */
import { describe, expect, it } from 'vitest'
import {
  getCallerExecutionHostId,
  selectEnclosingWorktreeOnHost,
  selectWorktreeIdOnHost
} from './caller-host-worktree-selection'

const PATH = '/srv/app'

function row(hostId: 'local' | `ssh:${string}` | undefined, id: string, identityKey?: string) {
  return {
    id,
    path: PATH,
    ...(hostId ? { hostId } : {}),
    ...(identityKey ? { identity: { key: identityKey } } : {})
  }
}

const SSH_CALLER_D = {
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'host d',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'inc-1',
  ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'att-1'
}

const TWINS = [
  row('ssh:host-a', `repo-a::${PATH}`),
  row('ssh:host%20d', `repo-d::${PATH}`),
  row('local', `repo-l::${PATH}`)
]

describe('implicit worktree selection is scoped to the caller host (#21210)', () => {
  it('reads the caller host from the relay stamp, encoding the SSH target', () => {
    expect(getCallerExecutionHostId(SSH_CALLER_D)).toBe('ssh:host%20d')
    expect(getCallerExecutionHostId({})).toBe('local')
    // A WSL stamp is still this machine.
    expect(
      getCallerExecutionHostId({
        ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
        ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'local',
        ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
      })
    ).toBe('local')
  })

  it("resolves an SSH caller's cwd to its own host's twin", () => {
    const hostId = getCallerExecutionHostId(SSH_CALLER_D)

    expect(selectEnclosingWorktreeOnHost(TWINS, `${PATH}/src`, hostId)).toBe(`id:repo-d::${PATH}`)
  })

  it('resolves a caller with no host stamp to the local row only', () => {
    expect(selectEnclosingWorktreeOnHost(TWINS, PATH, 'local')).toBe(`id:repo-l::${PATH}`)
  })

  // A runtime-stamped row in this runtime's own catalog is a checkout it holds locally.
  it('keeps a runtime-stamped local checkout for a local caller', () => {
    const rows = [
      TWINS[0]!,
      { id: `repo-r::${PATH}`, path: PATH, hostId: 'runtime:env-1' as const }
    ]

    expect(selectEnclosingWorktreeOnHost(rows, `${PATH}/src`, 'local')).toBe(`id:repo-r::${PATH}`)
    expect(selectEnclosingWorktreeOnHost(rows, PATH, 'ssh:host%20d')).toBeUndefined()
  })

  it('never adopts another host or an unstamped row for an SSH caller', () => {
    expect(
      selectEnclosingWorktreeOnHost([TWINS[0]!, row(undefined, 'repo-u::x')], PATH, 'ssh:host-z')
    ).toBeUndefined()
  })

  it('names the exact identity when another host shares the bare id', () => {
    const twins = [
      row('ssh:host-a', `repo-1::${PATH}`, 'wt2:a'),
      row('ssh:host%20d', `repo-1::${PATH}`, 'wt2:d')
    ]

    expect(selectEnclosingWorktreeOnHost(twins, PATH, 'ssh:host%20d')).toBe('identity:wt2:d')
    expect(selectWorktreeIdOnHost(twins, `repo-1::${PATH}`, 'ssh:host%20d')).toBe('identity:wt2:d')
    expect(selectWorktreeIdOnHost(twins, `repo-1::${PATH}`, 'ssh:host-z')).toBeUndefined()
  })
})
