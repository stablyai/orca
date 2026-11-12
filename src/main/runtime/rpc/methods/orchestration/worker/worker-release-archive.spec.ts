import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

export function registerWorkerReleaseArchiveTests(): void {
  function codexMessage(id: string, text: string): string {
    return JSON.stringify({
      timestamp: '2026-08-03T12:00:00.000Z',
      type: 'event_msg',
      payload: { id, type: 'agent_message', message: text }
    })
  }

  describe('orchestration worker release archive', () => {
    const h = createOrchestrationWorkerReleaseHarness()

    afterEach(() => h.cleanup())

    it('records unavailable output for an already-exited worker that reported no transcript', async () => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker()
      vi.mocked(h.runtime.showTerminal).mockImplementation(
        async (handle) => ({ handle, worktreeId: 'repo::worktree', connected: false }) as never
      )
      vi.mocked(h.runtime.readTerminal).mockResolvedValue({
        handle: 'term_worker',
        status: 'exited',
        tail: [],
        truncated: false,
        nextCursor: null
      })
      const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
        state: string
        processAction: string
        archive: { status: string | null } | null
      }
      expect(receipt).toMatchObject({
        state: 'released',
        processAction: 'closed_exited_terminal',
        archive: { status: 'unavailable' }
      })
    })

    it('keeps the conversation the agent reports last, so a follow-up can reopen it after release', async () => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker()
      // A /clear after the report moved the agent to a new conversation.
      vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
        paneKey: 'tab_worker:leaf',
        agent: 'claude',
        processIncarnation: 'runtime_test:term_worker:1',
        providerSession: { key: 'session_id', id: 'after-clear' },
        observedAt: 1
      })
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })

      expect(
        JSON.parse(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.resume_session ?? 'null')
      ).toMatchObject({ agent: 'claude', providerSession: { id: 'after-clear' } })
    })

    it('reads the original transcript after release, until the provider file disappears', async () => {
      h.setup()
      const directory = await mkdtemp(join(tmpdir(), 'orca-worker-release-snapshot-'))
      const transcriptPath = join(directory, 'rollout.jsonl')
      try {
        await writeFile(
          transcriptPath,
          `${codexMessage('snapshot-one', 'frozen first')}\n${codexMessage('snapshot-two', 'frozen second')}\n`
        )
        vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
          agent: 'codex',
          processIncarnation: 'runtime_test:term_worker:1',
          providerSession: {
            key: 'codex:snapshot-session',
            id: 'snapshot-session',
            transcriptPath
          }
        } as never)
        const { dispatchId } = await h.startSettledWorker()
        await h.call('orchestration.workerRelease', { dispatch: dispatchId })
        expect(h.db.getWorkerTerminalArchive(dispatchId)?.content).not.toContain('frozen')

        // Like a live read, the first page is the newest messages; a cursor then follows the file.
        const page = await h.call('orchestration.workerRead', { dispatch: dispatchId })
        const cursor =
          typeof page === 'object' && page !== null && 'cursor' in page ? page.cursor : null
        expect(page).toMatchObject({
          archived: true,
          source: 'transcript',
          transcript: {
            messages: [
              { id: 'snapshot-one', blocks: [{ type: 'text', text: 'frozen first' }] },
              { id: 'snapshot-two', blocks: [{ type: 'text', text: 'frozen second' }] }
            ]
          }
        })
        await appendFile(transcriptPath, `${codexMessage('resumed', 'after a resume')}\n`)
        await expect(
          h.call('orchestration.workerRead', { dispatch: dispatchId, cursor })
        ).resolves.toMatchObject({
          transcript: {
            messages: [{ id: 'resumed', blocks: [{ type: 'text', text: 'after a resume' }] }]
          }
        })
        // A cursor from the live terminal belongs to output that was released.
        await expect(
          h.call('orchestration.workerRead', { dispatch: dispatchId, cursor: 1 })
        ).rejects.toThrow(/source changed/i)

        await rm(transcriptPath)
        await expect(
          h.call('orchestration.workerRead', { dispatch: dispatchId })
        ).rejects.toMatchObject({ code: 'archive_unavailable' })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('preserves payload clipping metadata in the released transcript snapshot', async () => {
      h.setup()
      const directory = await mkdtemp(join(tmpdir(), 'orca-worker-release-clipped-snapshot-'))
      const transcriptPath = join(directory, 'rollout.jsonl')
      try {
        await writeFile(
          transcriptPath,
          `${JSON.stringify({
            timestamp: '2026-08-03T12:00:00.000Z',
            type: 'event_msg',
            payload: { id: 'clipped-message', type: 'agent_message', message: 'x'.repeat(5_000) }
          })}\n`
        )
        vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
          agent: 'codex',
          processIncarnation: 'runtime_test:term_worker:1',
          providerSession: {
            key: 'codex:clipped-session',
            id: 'clipped-session',
            transcriptPath
          }
        } as never)
        const { dispatchId } = await h.startSettledWorker()
        await h.call('orchestration.workerRelease', { dispatch: dispatchId })

        const read = (await h.call('orchestration.workerRead', { dispatch: dispatchId })) as {
          transcript: { limited: boolean }
          cursor: string
          contentComplete: boolean
          clipping: string[]
          warnings: string[]
        }

        expect(read).toMatchObject({
          transcript: { limited: true },
          contentComplete: false,
          clipping: ['transcript_payload'],
          warnings: ['Oversized transcript text was clipped.']
        })
        expect(read.cursor).toMatch(/^owr1_/)
        expect(read.warnings).not.toContain(
          'Older transcript messages were omitted from the bounded archive.'
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('recovers archive metadata when a prior attempt committed only the archive row', async () => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker()
      const requested = h.db.requestWorkerTerminalRelease(dispatchId)
      expect(requested.disposition).toBe('requested')
      if (requested.disposition !== 'requested') {
        throw new Error('release request was not recorded')
      }
      h.db.storeWorkerTerminalArchive({
        dispatchId,
        resourceId: requested.resource.id,
        kind: 'terminal_tail',
        content: JSON.stringify({
          lines: ['archive survived the interrupted attempt'],
          truncated: false,
          terminalStatus: 'running',
          warnings: []
        })
      })

      const release = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
        archive: { source: string | null; status: string | null } | null
      }

      expect(release.archive).toEqual({ source: 'terminal', status: 'captured' })
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        archive_source: 'terminal',
        archive_status: 'captured'
      })
    })
  })
}
