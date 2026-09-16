import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
import { WRITE_ACCEPTED } from '../../../shared/pty-write-settlement'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

function idleLeaf(lastOscTitle: string | null): OrchestrationMailboxLeaf {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle,
    paneTitle: null
  }
}

async function collectPointerWrites(
  leaf: OrchestrationMailboxLeaf,
  tabTitle: string | null = null
): Promise<string[]> {
  const db = new OrchestrationDb(':memory:')
  const message = db.insertMessage({
    runId: 'run_legacy_local',
    from: 'a',
    to: 'run:run-1',
    subject: 's'
  })
  const state = new OrchestrationMailboxPointerState()
  const writePty = vi.fn((_ptyId: string, _data: string) => WRITE_ACCEPTED)
  stageOrchestrationMailboxPointer({
    deps: {
      mailboxOwner: { resolve: () => 'run:run-1' },
      deliveryTarget: { resolveTerminalHandle: () => 'term-1', deferForAbsenceProbe: () => false },
      getDb: () => db,
      getLeaf: () => leaf,
      getLeafKey: () => 'tab-1:leaf-1',
      getLiveLeafForHandle: () => leaf,
      getMessageWaiters: () => undefined,
      getTabTitle: () => tabTitle,
      getCliCommand: () => 'orca' as const,
      getTerminalHandleForLeafKey: () => 'term-1',
      resolveSubmitTarget: () => ({
        leaf,
        terminalHandle: 'term-1',
        processIncarnation: 'inc-1'
      }),
      isLeafPtyProvenAbsent: async () => false,
      redriveMailbox: vi.fn(),
      writePty
    },
    state,
    leaf,
    mailboxHandle: 'run:run-1',
    messages: [{ id: message.id, type: 'status', sequence: 1 }],
    newestSequence: 1,
    enterDelayMs: 5,
    leafKey: 'tab-1:leaf-1',
    settle: (ptyId: string, flight: never) => state.settleFlight(ptyId, flight),
    redrive: vi.fn()
  } as never)
  await vi.waitFor(() => expect(writePty).toHaveBeenCalledWith(leaf.ptyId, '\r'))
  const payloads = writePty.mock.calls.map(([, data]) => data)
  db.close()
  return payloads
}

describe('mailbox pointer submit across agent titles', () => {
  it.each([['Cursor Ready'], ['Cursor Agent'], ['Codex done'], ['Claude Code'], ['Kimi']] as const)(
    'writes the pointer then Enter for %s',
    async (title) => {
      const payloads = await collectPointerWrites(idleLeaf(title))
      expect(payloads[0]).toContain('You have 1 orchestration message')
      expect(payloads[0]).not.toContain('\r')
      expect(payloads.at(-1)).toBe('\r')
    }
  )

  it('still submits when Cursor identity is only on the tab title', async () => {
    const payloads = await collectPointerWrites(idleLeaf(null), 'Cursor Ready')
    expect(payloads[0]).toContain('You have 1 orchestration message')
    expect(payloads.at(-1)).toBe('\r')
  })
})
