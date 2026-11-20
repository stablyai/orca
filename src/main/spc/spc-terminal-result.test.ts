import { expect, it } from 'vitest'
import { readSpcTerminalResult, SpcTerminalNotice } from './spc-terminal-result'

const scope = { workflow_id: 'workflow', serverpack_id: 'pack', test_task_id: 'test-task' }

it('waits on a persisted release at test completion and only uses the verified publication receipt', async () => {
  const test = SpcTerminalNotice.parse({
    ...scope,
    kind: 'spc_test_completed',
    correlation_id: 'notification-correlation',
    thread_id: 'notification-thread'
  })
  const result = await readSpcTerminalResult(test, async (tool, args) => {
    if (tool === 'task_log') {
      return {
        summary: {
          id: 'test-task',
          workflow_id: 'workflow',
          serverpack_id: 'pack',
          task_type: 'test',
          status: 'completed'
        }
      }
    }
    expect(tool).toBe('pack_status')
    expect(args).toEqual({ id: 'pack', test_task_id: 'test-task' })
    return {
      server_pack: { id: 'pack' },
      workflow_id: 'workflow',
      publication: { reviewed_test_log_id: 'test-task' },
      test: {
        log_id: 'later-test',
        passed: false,
        observed: false,
        process_reaped: false,
        process_running: true
      }
    }
  })
  expect(result).toEqual({ kind: 'ignored', reason: 'spc_waiting_for_publication' })

  const publication = SpcTerminalNotice.parse({
    ...scope,
    kind: 'spc_publish_finished',
    publish_id: 'publish-job',
    correlation_id: 'notification-correlation'
  })
  const job = {
    id: 'publish-job',
    workflow_id: 'workflow',
    serverpack_id: 'pack',
    reviewed_test_log_id: 'test-task',
    correlation_id: 'spc-readback',
    status: 'completed',
    archive_verified: true,
    artifact_sha256: 'a'.repeat(64),
    object_confirmed: true,
    object_url: 'https://objects.example/pack',
    verification: {
      matches: true,
      mismatch_count: 0,
      unverified_count: 0,
      fields: [{ matches: true }]
    }
  }
  expect(
    await readSpcTerminalResult(publication, async (tool, args) => {
      expect(tool).toBe('publish_status')
      expect(args).toEqual({ id: 'pack', publish_id: 'publish-job' })
      return job
    })
  ).toMatchObject({
    kind: 'delivery',
    correlationId: 'spc-readback',
    deliveryId: 'spc-published-workflow-pack'
  })
  expect(
    await readSpcTerminalResult(publication, async () => ({ ...job, object_confirmed: false }))
  ).toMatchObject({ kind: 'delivery', deliveryId: 'spc-result-workflow-publish-job' })
  expect(await readSpcTerminalResult(publication, async () => ({ ...job, id: 'new-job' }))).toEqual(
    { kind: 'ignored', reason: 'spc_task_mismatch' }
  )
})
