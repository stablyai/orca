import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from './db'
import { structuredSessionsOwedMail } from './structured-session-mail-target'

function dbWith(undelivered: string[], pointerPending: string[]) {
  return {
    getUndeliveredUnreadMailboxHandles: () => undelivered,
    getPendingMailboxPointerHandles: () => pointerPending
  }
}

const sessionsByMailbox: Record<string, string> = {
  'dispatch:d1': 'chat-a',
  'run:r1': 'chat-a',
  'orca_session_id:chat-b': 'chat-b'
}
function resolve(mailbox: string): { sessionId: string; dispatchId: null } | null {
  const sessionId = sessionsByMailbox[mailbox]
  return sessionId ? { sessionId, dispatchId: null } : null
}

describe('the chats parked mail waits on', () => {
  it('reads both pending-mail scans, once per chat, skipping mail no chat takes', () => {
    const db = dbWith(['dispatch:d1', 'term_pty_worker'], ['run:r1', 'orca_session_id:chat-b'])

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function reads only the two scans this stub defines.
    expect(structuredSessionsOwedMail(() => db as unknown as OrchestrationDb, resolve)).toEqual([
      'chat-a',
      'chat-b'
    ])
  })

  it('owes nothing with no database, and reports a failing one without throwing', () => {
    expect(structuredSessionsOwedMail(() => null, resolve)).toEqual([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = () => {
      throw new Error('database is locked')
    }

    expect(structuredSessionsOwedMail(failing, resolve)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
