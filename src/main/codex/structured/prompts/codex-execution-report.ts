import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import type { CodexAppServerServerRequest } from '../../app-server/codex-app-server-connection-types'
import { agentSessionExecutionReportSchema } from '../../../../shared/agent-session/agent-session-execution-report'
import { persistCodexExecutionReceipt } from '../session-lifecycle/codex-execution-receipt'

export function handleCodexExecutionReport(
  session: CodexSession,
  request: CodexAppServerServerRequest
): boolean {
  if (!session.execution || request.method !== 'item/tool/call') {
    return false
  }
  const execution = session.execution
  const params = readRecord(request.params)
  const parsed = agentSessionExecutionReportSchema.safeParse(params?.arguments)
  const refuse = () => session.connection.respond(request.id, { contentItems: [], success: false })
  if (
    !params ||
    params.threadId !== session.threadId ||
    params.tool !== 'orca_worker_report' ||
    (params.namespace !== undefined && params.namespace !== null) ||
    !parsed.success ||
    !execution.inputAdmitted ||
    !execution.reporter ||
    execution.report ||
    execution.invalidated ||
    session.ended ||
    !execution.controls.isOpen()
  ) {
    refuse()
    return true
  }
  execution.report = parsed.data
  void (async () => {
    try {
      await persistCodexExecutionReceipt(session)
      execution.controls.assertOpen()
      await execution.reporter!(parsed.data)
      session.connection.respond(request.id, { contentItems: [], success: true })
    } catch {
      execution.invalidated = true
      execution.checkpoint?.()
      refuse()
      execution.controls.stop()
    }
  })()
  return true
}
