import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

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
        const creatorSessionId = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
        const assigneeSessionId = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
        h.db.db
          .prepare(
            'UPDATE dispatch_contexts SET creator_orca_session_id = ?, assignee_orca_session_id = ? WHERE id = ?'
          )
          .run(creatorSessionId, assigneeSessionId, dispatchId)
        expect(await h.call('orchestration.workerRelease', { dispatch: dispatchId })).toMatchObject(
          {
            state: 'released',
            archive: { source: 'transcript', status: 'captured' }
          }
        )
        expect(await h.call('orchestration.workerShow', { dispatch: dispatchId })).toMatchObject({
          dispatch: {
            creatorOrcaSessionId: creatorSessionId,
            assigneeOrcaSessionId: assigneeSessionId
          }
        })
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
  })
}
