import { describe, expect, it } from 'vitest'
import { TERMINAL_USE_THROTTLE_MS, TerminalUseProducer } from './terminal-use-producer'
import type { AgentPaneWorkspace } from '../../agent-hooks/agent-transition-detector'

function harness(workspace: AgentPaneWorkspace | null, fenced = false) {
  const writes: string[] = []
  const records = new Set(['repo::/w', 'ssh:box|repo::/w', 'f1'])
  const producer = new TerminalUseProducer({
    store: () => ({
      getWorktreeMeta: (id) => (records.has(id) ? {} : undefined),
      setWorktreeMeta: ({ id, hostId }, u) => writes.push(`${hostId} ${id} ${u.lastTerminalUseAt}`),
      getRepos: () => [
        { id: 'repo', path: '/', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
      ],
      getWorktreeMetaForHost: (id, host) => (records.has(`${host}|${id}`) ? {} : undefined),
      getFolderWorkspace: (id) => (records.has(id) ? {} : undefined),
      updateFolderWorkspace: (id, u) => writes.push(`folder ${id} ${u.lastTerminalUseAt}`)
    }),
    workspaceOfPty: () => workspace,
    isWriteFenced: () => fenced
  })
  return { producer, writes }
}

describe('TerminalUseProducer', () => {
  it('writes on the record that owns the workspace: local, SSH host or folder', () => {
    for (const [workspace, expected] of [
      [{ worktreeId: 'repo::/w', sshHostId: null }, 'local repo::/w 5'],
      [{ worktreeId: 'repo::/w', sshHostId: 'ssh:box' }, 'ssh:box repo::/w 5'],
      [{ worktreeId: 'folder:f1', sshHostId: null }, 'folder f1 5']
    ] as const) {
      const { producer, writes } = harness(workspace)
      producer.noteTerminalUse('pty', 5)
      expect(writes).toEqual([expected])
    }
  })

  it('throttles per workspace, and writes nothing for an unknown PTY, a stale id or a fenced move', () => {
    const { producer, writes } = harness({ worktreeId: 'repo::/w', sshHostId: null })
    producer.noteTerminalUse('pty', 0)
    producer.noteTerminalUse('pty', TERMINAL_USE_THROTTLE_MS - 1)
    expect(writes).toEqual(['local repo::/w 0'])

    const unknown = harness(null)
    unknown.producer.noteTerminalUse('pty', 0)
    const stale = harness({ worktreeId: 'repo::/gone', sshHostId: null })
    stale.producer.noteTerminalUse('pty', 0)
    const fenced = harness({ worktreeId: 'repo::/w', sshHostId: null }, true)
    fenced.producer.noteTerminalUse('pty', 0)
    expect([...unknown.writes, ...stale.writes, ...fenced.writes]).toEqual([])
  })
})
