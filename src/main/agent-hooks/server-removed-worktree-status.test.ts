import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { LEAF_1, LEAF_2, LEAF_3, LEAF_4, LEAF_5, recentTs } from './server.test-fixtures'

const REMOVED = 'repo-1::/workspace/removed'
const KEPT = 'repo-1::/workspace/kept'
const LOCAL_PANE = makePaneKey('tab-local', LEAF_1)
const WSL_PANE = makePaneKey('tab-wsl', LEAF_2)
const SSH_PANE = makePaneKey('tab-ssh', LEAF_3)
const SSH_COMMITMENT_PANE = makePaneKey('tab-ssh-idle', LEAF_4)
const OTHER_PANE = makePaneKey('tab-other', LEAF_5)

function row(paneKey: string, worktreeId: string, connectionId: string | null) {
  const receivedAt = recentTs()
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId,
    connectionId,
    receivedAt,
    stateStartedAt: receivedAt,
    payload: { state: 'working', prompt: 'stranded', agentType: 'codex' }
  }
}

describe('AgentHookServer removed-worktree retirement', () => {
  let userDataPath: string
  const lastStatusPath = () => join(userDataPath, 'agent-hooks', 'last-status.json')

  beforeEach(() => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-removed-worktree-'))
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [LOCAL_PANE]: row(LOCAL_PANE, REMOVED, null),
          [WSL_PANE]: row(WSL_PANE, REMOVED, 'wsl:Ubuntu'),
          [SSH_PANE]: row(SSH_PANE, REMOVED, 'user@box'),
          [OTHER_PANE]: row(OTHER_PANE, KEPT, null)
        }
      }),
      'utf8'
    )
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('retires only the removing host rows and commitments, then persists the pruned map', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      // An SSH commitment recorded this session outlives its row across a disconnect clear.
      server.ingestRemote(
        {
          paneKey: SSH_COMMITMENT_PANE,
          tabId: 'tab-ssh-idle',
          worktreeId: REMOVED,
          launchToken: 'idle-launch',
          payload: { state: 'working', prompt: 'idle', agentType: 'codex' }
        },
        'idle@box'
      )
      server.clearStatusEntriesForConnection('idle@box')
      const persisted = () => {
        server.flushStatusPersistSync()
        const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
        return {
          entries: Object.keys(file.entries).sort(),
          commitments: Object.keys(file.authorityCommitments ?? {})
        }
      }

      server.dropStatusEntriesForRemovedWorktree(REMOVED, 'runtime:env-1')
      expect(persisted().entries).toHaveLength(4)

      server.dropStatusEntriesForRemovedWorktree(REMOVED, 'local')
      expect(persisted()).toEqual({
        entries: [OTHER_PANE, SSH_PANE].sort(),
        commitments: [SSH_COMMITMENT_PANE]
      })

      server.dropStatusEntriesForRemovedWorktree(REMOVED, 'ssh:user%40box')
      expect(persisted()).toEqual({ entries: [OTHER_PANE], commitments: [SSH_COMMITMENT_PANE] })

      server.dropStatusEntriesForRemovedWorktree(REMOVED, 'ssh:idle%40box')
      expect(persisted().commitments).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('fences only the retired pane, so its kept tab still reports a new agent', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.dropStatusEntriesForRemovedWorktree(REMOVED, 'local')
      const newPane = makePaneKey('tab-local', '66666666-6666-4666-8666-666666666666')
      const done = { state: 'done', prompt: 'late', agentType: 'codex' } as const
      server.ingestTerminalStatus({ paneKey: LOCAL_PANE, connectionId: null, payload: done })
      server.ingestTerminalStatus({ paneKey: newPane, connectionId: null, payload: done })

      const panes = server.getStatusSnapshot().map((entry) => entry.paneKey)
      expect(panes).toContain(newPane)
      expect(panes).not.toContain(LOCAL_PANE)
    } finally {
      server.stop()
    }
  })

  it.each([
    { occupant: 'the removed worktree', sshWorktree: KEPT, localWorktree: REMOVED, host: 'local' },
    {
      occupant: 'another owner',
      sshWorktree: REMOVED,
      localWorktree: KEPT,
      host: 'ssh:user%40box'
    }
  ] as const)(
    'decides a reused pane by its occupant: $occupant',
    async ({ sshWorktree, localWorktree, host }) => {
      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath })
      try {
        const pane = makePaneKey('tab-reused', '77777777-7777-4777-8777-777777777777')
        const working = { state: 'working', prompt: 'live', agentType: 'codex' } as const
        const reportLocally = (state: 'working' | 'done') =>
          server.ingestTerminalStatus({
            paneKey: pane,
            worktreeId: localWorktree,
            connectionId: null,
            payload: { ...working, state }
          })
        server.ingestRemote(
          {
            paneKey: pane,
            tabId: 'tab-reused',
            worktreeId: sshWorktree,
            launchToken: 'ssh',
            payload: working
          },
          'user@box'
        )
        server.clearStatusEntriesForConnection('user@box')
        reportLocally('working')

        server.dropStatusEntriesForRemovedWorktree(REMOVED, host)
        reportLocally('done')

        server.flushStatusPersistSync()
        const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
        if (localWorktree === REMOVED) {
          expect(file.authorityCommitments?.[pane]).toMatchObject({ worktreeId: KEPT })
          // The retained foreign launch fence rejects the removed workspace's late repaint.
          expect(file.entries[pane]).toBeUndefined()
        } else {
          expect(file.authorityCommitments?.[pane]).toBeUndefined()
          // The occupant keeps reporting, without the removed owner's token hash stamped on its row.
          expect(file.entries[pane]).toMatchObject({ worktreeId: KEPT, payload: { state: 'done' } })
          expect(file.entries[pane].launchTokenHash).toBeUndefined()
        }
      } finally {
        server.stop()
      }
    }
  )
})
