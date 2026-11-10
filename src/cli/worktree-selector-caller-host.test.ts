import { describe, expect, it } from 'vitest'
import {
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

const TWINS = [
  row('ssh:host-a', `repo-a::${PATH}`),
  row('ssh:host%20d', `repo-d::${PATH}`),
  row('local', `repo-l::${PATH}`)
]

describe('implicit worktree selection is scoped to the caller host (#21210)', () => {
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
