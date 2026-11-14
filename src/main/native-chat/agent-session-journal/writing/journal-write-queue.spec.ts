import { describe, expect, it } from 'vitest'
import { createFixture } from '../store-lifecycle/journal-store-contract-test-fixture'
import { JournalWriteQueue, type JournalWriteAdmission } from './journal-write-queue'

export function registerJournalWriteQueueTests(): void {
  const fixture = createFixture()

  describe('the journal write queue', () => {
    it.each(['submission', 'queued'] as const)(
      'publishes a committed %s when admission later rejects',
      async (kind) => {
        const journal = await fixture.open()
        const published: string[] = []
        journal.observeCommits((rows) => {
          if (rows?.length) {
            published.push('committed')
          }
        })
        const fault = new Error('capsule release failed')
        const admission: JournalWriteAdmission = async (write) => {
          write()
          throw fault
        }
        const body = {
          kind: 'message' as const,
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: 'Resume the task' }]
        }
        const write =
          kind === 'submission'
            ? journal.appendSubmission(
                { clientMessageId: 'resume-1', payloadFingerprint: 'resume-fp', body, fence: 1 },
                undefined,
                undefined,
                undefined,
                admission
              )
            : journal.queuedMessages.insert({ messageId: 'resume-1', body }, undefined, admission)
        await expect(write).rejects.toBe(fault)
        expect(published).toEqual(['committed'])
        if (kind === 'submission') {
          expect(journal.submission('resume-1')).toMatchObject({ clientMessageId: 'resume-1' })
        } else {
          expect(journal.queuedMessages.get('resume-1')).toMatchObject({ messageId: 'resume-1' })
        }
        await journal.queuedMessages.insert({ messageId: 'next', body })
        expect(journal.queuedMessages.get('next')).toMatchObject({ messageId: 'next' })
      }
    )

    it('does not publish an admission rejected before commit and preserves both post-commit faults', async () => {
      const journal = await fixture.open()
      const body = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Resume the task' }]
      }
      const lockFault = new Error('capsule release failed')
      const publicationFault = new Error('observer unavailable')
      journal.observeCommits(() => {
        throw publicationFault
      })
      const before: JournalWriteAdmission = async () => {
        throw lockFault
      }
      await expect(
        journal.queuedMessages.insert({ messageId: 'not-accepted', body }, undefined, before)
      ).rejects.toBe(lockFault)
      expect(journal.queuedMessages.get('not-accepted')).toBeNull()
      const after: JournalWriteAdmission = async (write) => {
        write()
        throw lockFault
      }
      await expect(
        journal.queuedMessages.insert({ messageId: 'accepted', body }, undefined, after)
      ).rejects.toMatchObject({
        cause: lockFault,
        errors: [lockFault, publicationFault]
      })
      expect(journal.queuedMessages.get('accepted')).toMatchObject({ messageId: 'accepted' })
    })

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
