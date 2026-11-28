import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { getOptionalStructuredMessagePayload } from '../../../../../../cli/orchestration/messages/message-payload'

it('reopens the bytes of each submitted report by message after the worker folder is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-worker-report-'))
  const folder = join(root, 'worker')
  const harness = createOrchestrationRpcHarness()
  try {
    await mkdir(folder)
    const { db, runtime, ctx } = harness.setup(true, null, join(root, 'mail.db'))
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const pane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? pane : harness.coordinatorPaneKey
    )
    const submit = async (spec: string, bytes?: Buffer, omitDispatch = false) => {
      const task = db.createTask({ spec })
      const dispatch = createRootDispatch(
        db,
        task.id,
        'term_worker',
        pane,
        undefined,
        'runtime_test:term_worker:1'
      )
      const flags = new Map([
        ['type', 'worker_done'],
        ['task-id', task.id],
        ['outcome', 'succeeded']
      ])
      if (!omitDispatch) {
        flags.set('dispatch-id', dispatch.id)
      }
      if (bytes) {
        flags.set('report-path', 'report.bin')
        await writeFile(join(folder, 'report.bin'), bytes)
      }
      const request = {
        id: spec,
        method: 'orchestration.send',
        authToken: 'test',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: `request_${spec}`,
        params: {
          from: 'term_worker',
          subject: spec,
          type: 'worker_done',
          payload: await getOptionalStructuredMessagePayload(flags, folder)
        }
      }
      if (omitDispatch) {
        const wrongFlags = new Map(flags).set('dispatch-id', 'ctx_previous')
        const wrong = await dispatcher.dispatch({
          ...request,
          orchestrationRequestId: 'request_wrong_dispatch',
          params: {
            ...request.params,
            run: dispatch.run_id,
            payload: await getOptionalStructuredMessagePayload(wrongFlags, folder)
          }
        })
        expect(wrong).toMatchObject({ ok: false, error: { code: 'dispatch_inactive' } })
        expect(db.getTask(task.id)?.status).toBe('dispatched')
      }
      const sent = await dispatcher.dispatch(request)
      expect(sent).toMatchObject({ ok: true, result: { lifecycle: { action: 'completed' } } })
      const result = JSON.parse(db.getTask(task.id)!.result!)
      return { request, messageId: result.messageId, dispatchId: dispatch.id }
    }
    const a = await submit('first', Buffer.from([0, 255, 65]), true)
    const b = await submit('second', Buffer.from('B\r\n'))
    const body = await submit('plain')
    await rm(folder, { recursive: true })
    const reopened = harness.reopenDatabase()
    for (const [report, contentBase64] of [
      [a, 'AP9B'],
      [b, 'Qg0K']
    ] as const) {
      const read = await harness.call('orchestration.inbox', { report: report.messageId }, ctx)
      expect(read).toMatchObject({
        reportFile: {
          messageId: report.messageId,
          dispatchId: report.dispatchId,
          reportPath: 'report.bin',
          contentBase64,
          sha256: createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex')
        }
      })
    }
    await expect(
      harness.call('orchestration.inbox', { report: a.messageId, terminal: 'term_worker' }, ctx)
    ).rejects.toThrow('no captured report')
    await expect(
      getOptionalStructuredMessagePayload(
        new Map([
          ['type', 'worker_done'],
          ['report-path', 'missing.bin']
        ]),
        root
      )
    ).rejects.toThrow('Cannot capture --report-path')
    expect(await dispatcher.dispatch(a.request)).toMatchObject({
      ok: true,
      result: { message: { id: a.messageId }, mutation: { replayed: true } }
    })
    await expect(
      harness.call('orchestration.inbox', { report: body.messageId }, ctx)
    ).rejects.toThrow('no captured report')
    reopened.db.prepare('DELETE FROM messages WHERE id = ?').run(a.messageId)
    expect(
      reopened.db.prepare('SELECT 1 FROM worker_report_files WHERE message_id = ?').get(a.messageId)
    ).toBeUndefined()
  } finally {
    harness.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
