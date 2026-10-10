import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-types'
import {
  applyWorktreeHostContextLabels,
  buildHostLabelById,
  buildRepoHostIdByRepoId,
  getWorktreeHostContextLabels,
  resolveWorktreeHostId
} from './worktree-host-context-labels'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'repo-1::/home/me/orca',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'main',
    displayName: 'main',
    path: '/home/me/orca',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

const sshHostId = 'ssh:ssh-1785104650217-eduhep' as const

describe('buildHostLabelById', () => {
  it('labels SSH targets by their registered label and lets a display override win', () => {
    const labels = buildHostLabelById({
      sshTargets: [
        { id: 'ssh-1785104650217-eduhep', label: 'openclaw' },
        { id: 'ssh-blank', label: '   ' }
      ],
      hostSettingOverrides: { [sshHostId]: { displayLabel: 'openclaw (renamed)' } }
    })
    expect(labels.get(sshHostId)).toBe('openclaw (renamed)')
    expect(labels.has('ssh:ssh-blank')).toBe(false)
  })

  it('normalizes legacy raw SSH ids used by persisted display overrides', () => {
    const labels = buildHostLabelById({
      sshTargets: [],
      hostSettingOverrides: { 'ssh-1785104650217-eduhep': { displayLabel: 'openclaw' } }
    })
    expect(labels.get(sshHostId)).toBe('openclaw')
  })

  it('accepts canonical SSH host ids from newer target-summary payloads', () => {
    const labels = buildHostLabelById({
      sshTargets: [{ id: sshHostId, label: 'openclaw' }],
      hostSettingOverrides: undefined
    })
    expect(labels.get(sshHostId)).toBe('openclaw')
    expect(labels.has('ssh:ssh:ssh-1785104650217-eduhep')).toBe(false)
  })

  it('tolerates a malformed settings payload', () => {
    expect(buildHostLabelById({ sshTargets: [], hostSettingOverrides: 'nope' }).size).toBe(0)
    expect(buildHostLabelById({ sshTargets: [], hostSettingOverrides: undefined }).size).toBe(0)
  })
})

describe('resolveWorktreeHostId', () => {
  it('prefers the row host, then the repo host, then local', () => {
    const repoHosts = buildRepoHostIdByRepoId([
      { id: 'repo-1', connectionId: 'ssh-1785104650217-eduhep' },
      { id: 'repo-2', executionHostId: 'runtime:env-1' },
      { id: 'repo-3' }
    ])
    expect(resolveWorktreeHostId(worktree({ hostId: 'local', repoId: 'repo-1' }), repoHosts)).toBe(
      'local'
    )
    expect(resolveWorktreeHostId(worktree({ repoId: 'repo-1' }), repoHosts)).toBe(sshHostId)
    expect(resolveWorktreeHostId(worktree({ repoId: 'repo-2' }), repoHosts)).toBe('runtime:env-1')
    expect(resolveWorktreeHostId(worktree({ repoId: 'repo-3' }), repoHosts)).toBe('local')
    expect(resolveWorktreeHostId(worktree({ repoId: 'unknown' }), repoHosts)).toBe('local')
  })
})

describe('getWorktreeHostContextLabels', () => {
  const sources = {
    repoHostIdByRepoId: new Map(),
    hostLabelById: new Map([[sshHostId, 'openclaw']]),
    hostPlatform: 'darwin' as const
  }

  it('returns nothing for a single-host list', () => {
    const rows = [worktree({ hostId: 'local' }), worktree({ hostId: 'local', worktreeId: 'b' })]
    expect(getWorktreeHostContextLabels(rows, sources)).toBeUndefined()
    expect(applyWorktreeHostContextLabels(rows, sources)).toBe(rows)
  })

  it('names every row by host once the list spans hosts', () => {
    const rows = [
      worktree({ hostId: 'local', worktreeId: 'a' }),
      worktree({ hostId: sshHostId, worktreeId: 'b' }),
      worktree({ hostId: 'ssh:unlabeled', worktreeId: 'c' }),
      worktree({ hostId: 'runtime:env-1', worktreeId: 'd' })
    ]
    const labeled = applyWorktreeHostContextLabels(rows, sources)
    expect(labeled.map((row) => row.hostContextLabel)).toEqual([
      'Local Mac',
      'openclaw',
      'unlabeled',
      'env-1'
    ])
  })

  it('names the local host from the paired host platform, not the phone', () => {
    const rows = [
      worktree({ hostId: 'local', worktreeId: 'a' }),
      worktree({ hostId: sshHostId, worktreeId: 'b' })
    ]
    const linux = applyWorktreeHostContextLabels(rows, { ...sources, hostPlatform: 'linux' })
    expect(linux[0].hostContextLabel).toBe('Local Linux')
    const unknown = applyWorktreeHostContextLabels(rows, { ...sources, hostPlatform: null })
    expect(unknown[0].hostContextLabel).toBe('This computer')
  })

  it('keys labels by host-qualified identity so a shared id on two hosts gets two labels', () => {
    const rows = [
      worktree({ hostId: 'local', worktreeId: 'same' }),
      worktree({ hostId: sshHostId, worktreeId: 'same' })
    ]
    const labeled = applyWorktreeHostContextLabels(rows, sources)
    expect(labeled.map((row) => row.hostContextLabel)).toEqual(['Local Mac', 'openclaw'])
  })

  it('falls back to the repo host for rows from hosts that predate hostId stamping', () => {
    const rows = [
      worktree({ repoId: 'repo-local', worktreeId: 'a' }),
      worktree({ repoId: 'repo-ssh', worktreeId: 'b' })
    ]
    const labeled = applyWorktreeHostContextLabels(rows, {
      ...sources,
      repoHostIdByRepoId: buildRepoHostIdByRepoId([
        { id: 'repo-local' },
        { id: 'repo-ssh', connectionId: 'ssh-1785104650217-eduhep' }
      ])
    })
    expect(labeled.map((row) => row.hostContextLabel)).toEqual(['Local Mac', 'openclaw'])
    expect(labeled.map((row) => row.hostContextHostId)).toEqual(['local', sshHostId])
  })

  it('keeps labels distinct when legacy rows reuse an id across hosts', () => {
    const rows = [
      worktree({ repoId: 'repo-local', worktreeId: 'same' }),
      worktree({ repoId: 'repo-ssh', worktreeId: 'same' })
    ]
    const labeled = applyWorktreeHostContextLabels(rows, {
      ...sources,
      repoHostIdByRepoId: buildRepoHostIdByRepoId([
        { id: 'repo-local' },
        { id: 'repo-ssh', connectionId: 'ssh-1785104650217-eduhep' }
      ])
    })
    expect(labeled.map((row) => row.hostContextLabel)).toEqual(['Local Mac', 'openclaw'])
  })
})
