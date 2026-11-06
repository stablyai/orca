import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeTestJournalHostDatabases } from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'
import { JournalWriteQueue } from './journal-write-queue'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

export function registerJournalWriteQueueTests(): void {
  void ({
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  } as const)

  let root = ''
  const opened: AgentSessionJournal[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-write-queue-'))
  })

  afterEach(async () => {
    await Promise.allSettled(opened.splice(0).map((journal) => journal.close()))
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  describe('the journal write queue', () => {
    it('runs a write issued from inside a running one after it, in issue order', async () => {
      const queue = new JournalWriteQueue('session-1')
      const ran: string[] = []
      let nested: Promise<void> | null = null
      const outer = queue.serialize(() => {
        nested = queue.serialize(() => {
          ran.push('nested')
        })
        ran.push('outer')
      })
      const after = queue.serialize(() => {
        ran.push('after')
      })
      expect(ran).toEqual(['outer'])
      await Promise.all([outer, nested, after])
      expect(ran).toEqual(['outer', 'nested', 'after'])
    })
  })

  describe('a read in the journal write queue', () => {
    it('runs behind a write that failed', async () => {
      const queue = new JournalWriteQueue('session-1')
      let failed: Promise<unknown> = Promise.resolve()
      let read: Promise<string> = Promise.resolve('')
      await queue.serialize(() => {
        failed = queue.serialize(() => {
          throw new Error('disk I/O error')
        })
        read = queue.readInOrder(() => 'read')
      })
      await expect(failed).rejects.toThrow('disk I/O error')
      await expect(read).resolves.toBe('read')
    })
  })
}
