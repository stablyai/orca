import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import {
  createBoundRun,
  createRuntime,
  insertDirectRunMessage,
  LAUNCH_TOKEN,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  TAB_ID,
  temporaryDirectories,
  TERMINAL_HANDLE,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))

describe('orchestration mail to a Pi terminal with a reported draft', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('holds the pointer while Pi reports unsent text and delivers once it is cleared', async () => {
    const hooks = new AgentHookServer()
    await hooks.start({ env: 'production' })
    const env = hooks.buildPtyEnv()
    const postPi = async (payload: Record<string, unknown>): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          launchToken: LAUNCH_TOKEN,
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          env: 'production',
          payload
        })
      })
      expect(response.ok).toBe(true)
    }
    const db = new OrchestrationDb(':memory:')
    try {
      const { runtime, write } = await createRuntime(db, {
        launchAgent: 'pi',
        getAgentStatusSnapshot: () => hooks.getStatusSnapshot()
      })
      await runtime.listTerminals()
      // Pi's screen shows no draft here; only its own report says one is typed.
      await postPi({ hook_event_name: 'agent_end', composer_draft: true })
      // Pi's idle title gives the terminal live idle status.
      runtime.onPtyData(PTY_ID, '\x1b]0;π - mailbox\x07', 1)
      await runtime.serializeMainTerminalBuffer(PTY_ID)
      const run = createBoundRun(db, 'Pi coordinator')
      insertDirectRunMessage(db, run.id, 'Worker finished')

      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(pointerCount(write)).toBe(0)
      expect(runtime.readTerminalMailHold(`run:${run.id}`)).toEqual({ kind: 'draft' })

      await postPi({ hook_event_name: 'composer_draft', composer_draft: false })
      expect(runtime.readTerminalMailHold(`run:${run.id}`)).toBeNull()
      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await vi.waitFor(() => expect(pointerCount(write)).toBe(1))
    } finally {
      db.close()
      hooks.stop()
    }
  })
})
