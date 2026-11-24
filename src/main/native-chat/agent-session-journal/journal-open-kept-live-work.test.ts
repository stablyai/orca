import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { createTrackedJournalOpener } from './store-lifecycle/journal-host-database-test-support'

const journals = createTrackedJournalOpener()
const roots: string[] = []
afterEach(async () => {
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function reopenedTaskState(keptWriter: boolean): Promise<string | undefined> {
  const root = await mkdtemp(join(tmpdir(), 'orca-kept-live-work-'))
  roots.push(root)
  const options = {
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root,
    now: () => 1_800_000_000_000
  }
  const first = await journals.open(options)
  await first.appendItem(
    { provider: 'orca', clientMessageId: 'task-row' },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'background-task',
          taskId: 'sleep',
          kind: 'command',
          label: 'sleep 600',
          state: 'working'
        }
      ]
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await first.close()
  const reopened = await journals.open({ ...options, ...(keptWriter ? { keptWriter: true } : {}) })
  const frame = await reopened.history({ direction: 'tail' })
  const item = frame.result.ok ? frame.result.page.items[0] : undefined
  const block = item?.body.kind === 'message' ? item.body.blocks[0] : undefined
  return block?.type === 'background-task' ? block.state : undefined
}

it('a chat whose agent the terminal host kept keeps its background task live across the reopen', async () => {
  expect(await reopenedTaskState(true)).toBe('working')
  // Without a kept writer the last run's host is gone, so its live work can't be vouched for.
  expect(await reopenedTaskState(false)).not.toBe('working')
})
