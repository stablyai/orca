import { z } from 'zod'

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const Correlation = z
  .string()
  .max(128)
  .nullish()
  .transform((value) => value || undefined)
const Status = z.string().max(64)
const Policy = z.object({ upload_rustfs: z.boolean(), publish_spl: z.boolean() })
const noticeIds = { workflow_id: Id, serverpack_id: Id }

export const SpcTerminalNotice = z.discriminatedUnion('kind', [
  z.object({
    ...noticeIds,
    kind: z.literal('spc_test_completed'),
    test_task_id: Id
  }),
  z.object({
    ...noticeIds,
    kind: z.literal('spc_publish_finished'),
    test_task_id: Id.optional(),
    publish_id: Id
  })
])

export type SpcTerminalNotice = z.infer<typeof SpcTerminalNotice>
export type SpcRead = (
  tool: 'task_log' | 'pack_status' | 'publish_status',
  args: Record<string, string | number>
) => Promise<unknown>

const TestLog = z.object({
  summary: z.object({
    id: Id,
    workflow_id: Id,
    task_type: z.literal('test'),
    serverpack_id: Id.optional(),
    status: Status,
    correlation_id: Correlation,
    post_test: Policy.nullish()
  }),
  correlation_id: Correlation
})

const PackStatus = z.object({
  server_pack: z.object({ id: Id }),
  workflow_id: Id,
  publication_error: z.string().optional(),
  publication: z
    .object({
      reviewed_test_log_id: Id.optional(),
      post_test: Policy.nullish()
    })
    .nullish(),
  test: z.object({
    log_id: z.string(),
    passed: z.boolean(),
    observed: z.boolean(),
    process_reaped: z.boolean(),
    process_running: z.boolean(),
    done: z.object({ message: z.string() }).optional(),
    success: z.object({ message: z.string() }).optional()
  })
})

const Publication = z.object({
  ...noticeIds,
  id: Id,
  correlation_id: Correlation,
  reviewed_test_log_id: Id.optional(),
  status: Status,
  post_test: Policy.nullish(),
  archive_verified: z.boolean(),
  artifact_sha256: z.string().optional(),
  object_confirmed: z.boolean(),
  object_url: z.string().optional(),
  verification: z
    .object({
      matches: z.boolean(),
      mismatch_count: z.number().int(),
      unverified_count: z.number().int(),
      fields: z.array(z.object({ matches: z.boolean(), unknown: z.boolean().optional() }))
    })
    .nullish()
})

const terminal = (status: string) => ['completed', 'failed', 'error', 'cancelled'].includes(status)
const processesArchive = (policy: z.infer<typeof Policy> | null | undefined) =>
  Boolean(policy?.publish_spl || policy?.upload_rustfs)

type SpcResult =
  | { kind: 'ignored'; reason: string }
  | { kind: 'delivery'; deliveryId: string; correlationId?: string; text: string }

export async function readSpcTerminalResult(
  notice: SpcTerminalNotice,
  read: SpcRead
): Promise<SpcResult> {
  const { workflow_id: workflow, serverpack_id: pack } = notice
  const result = (
    task: string,
    text: string,
    correlationId?: string,
    published = false
  ): SpcResult => ({
    kind: 'delivery',
    deliveryId: published ? `spc-published-${workflow}-${pack}` : `spc-result-${workflow}-${task}`,
    correlationId,
    text: `SPC · ${text}\n服务端包 ${pack}\n工作流 ${workflow}\n任务 ${task}`
  })

  if (notice.kind === 'spc_publish_finished') {
    const publish = Publication.parse(
      await read('publish_status', { id: pack, publish_id: notice.publish_id })
    )
    if (
      publish.id !== notice.publish_id ||
      publish.workflow_id !== workflow ||
      publish.serverpack_id !== pack ||
      (notice.test_task_id && publish.reviewed_test_log_id !== notice.test_task_id)
    ) {
      return { kind: 'ignored', reason: 'spc_task_mismatch' }
    }
    if (!terminal(publish.status)) {
      throw new Error('SPC publication has not reached a terminal state.')
    }
    const publishes = publish.post_test?.publish_spl ?? true
    const uploads = publish.post_test?.upload_rustfs ?? true
    if (!publishes && !uploads) {
      return { kind: 'ignored', reason: 'spc_test_only_policy' }
    }
    const sync = publish.verification
    const verified =
      publish.archive_verified &&
      /^[a-f0-9]{64}$/i.test(publish.artifact_sha256 ?? '') &&
      (!uploads || (publish.object_confirmed && Boolean(publish.object_url))) &&
      (!publishes ||
        (sync?.matches &&
          sync.mismatch_count === 0 &&
          sync.unverified_count === 0 &&
          sync.fields.length > 0 &&
          sync.fields.every((field) => field.matches && !field.unknown)))
    const text =
      publish.status === 'cancelled'
        ? '发布已取消'
        : publish.status !== 'completed'
          ? '发布失败'
          : !verified
            ? '任务已结束，发布证据未通过验收'
            : publishes
              ? '发布完成，已验收'
              : '归档处理完成，已验收'
    return result(
      publish.id,
      text,
      publish.correlation_id,
      Boolean(publishes && publish.status === 'completed' && verified)
    )
  }

  const { test_task_id: task } = notice
  const [logValue, packValue] = await Promise.all([
    read('task_log', { id: task, limit: 1 }),
    read('pack_status', { id: pack, test_task_id: task })
  ])
  const { summary, correlation_id: correlationId } = TestLog.parse(logValue)
  const state = PackStatus.parse(packValue)
  if (
    summary.id !== task ||
    summary.workflow_id !== workflow ||
    state.server_pack.id !== pack ||
    state.workflow_id !== workflow ||
    (summary.serverpack_id && summary.serverpack_id !== pack)
  ) {
    return { kind: 'ignored', reason: 'spc_task_mismatch' }
  }
  if (!terminal(summary.status) || state.publication_error) {
    throw new Error('SPC test or publication state is not available yet.')
  }
  if (state.test.log_id !== task && summary.serverpack_id !== pack) {
    return { kind: 'ignored', reason: 'spc_test_superseded' }
  }
  const job = state.publication
  if (
    (summary.status === 'completed' && processesArchive(summary.post_test)) ||
    (job?.reviewed_test_log_id === task && (!job.post_test || processesArchive(job.post_test)))
  ) {
    return { kind: 'ignored', reason: 'spc_waiting_for_publication' }
  }
  const test = state.test
  const passed =
    summary.status === 'completed' &&
    test.log_id === task &&
    test.passed &&
    test.observed &&
    test.process_reaped &&
    !test.process_running &&
    Boolean(test.done && test.success)
  const text =
    summary.status === 'cancelled'
      ? '启动测试已取消'
      : summary.status !== 'completed'
        ? '启动测试失败'
        : passed
          ? '启动测试通过，未验证玩家登录或玩法'
          : '测试已结束，启动证据未通过验收'
  return result(task, text, summary.correlation_id ?? correlationId)
}
