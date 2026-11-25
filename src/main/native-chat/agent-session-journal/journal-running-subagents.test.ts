import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from './store-lifecycle/journal-host-database-test-support'

const journals = createTrackedJournalOpener()
const roots: string[] = []
afterEach(async () => {
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('names every child whose saved turn is still open, with its parent, after the app is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-running-subagents-'))
  roots.push(root)
  const options = {
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('parent')
    },
    stateDirectory: root,
    now: () => 1_800_000_000_000
  }
  const first = await journals.open(options)
  const turn = async (
    agentId: string,
    turnId: string,
    state: 'running' | 'completed',
    parentAgentId?: string
  ) => {
    const turnItemId = `turn:${agentId}:${turnId}`
    await first.appendItem(
      { provider: 'orca', clientMessageId: turnItemId },
      { kind: 'turn', turnId, state },
      {
        fence: 1,
        agentId,
        ...(parentAgentId ? { parentAgentId } : {}),
        producerKind: 'agent',
        turnScope: { kind: 'turn', turnItemId }
      }
    )
  }
  // Spawned in the parent's first turn and still working; another child that finished; a grandchild.
  await turn('child-s', 's-1', 'running')
  await turn('child-t', 't-1', 'completed')
  await turn('grandchild', 'g-1', 'running', 'child-s')
  // No hand-off: the reopen knows only what was saved.
  await first.close()
  const reopened = await journals.open({ ...options, keptWriter: true })
  const running = await reopened.reads.runningSubagents()
  expect(running.toSorted((a, b) => a.agentId.localeCompare(b.agentId))).toEqual([
    { agentId: 'child-s' },
    { agentId: 'grandchild', parentAgentId: 'child-s' }
  ])
})
