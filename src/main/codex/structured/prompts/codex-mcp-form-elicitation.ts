import type { AcpRequestPresentation } from '../../../acp/acp-dialects/acp-dialect'
import { acpFormElicitationPresentation } from '../../../acp/requests/acp-form-elicitation'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { isCodexMcpToolApproval } from './codex-mcp-tool-approval'

/** An MCP server's own form, on the question card ACP forms use; null for a tool-call approval or a form Orca can't show. */
export function codexMcpFormPresentation(params: unknown): AcpRequestPresentation | null {
  if (isCodexMcpToolApproval(params)) {
    return null
  }
  let presentation: AcpRequestPresentation
  try {
    presentation = acpFormElicitationPresentation(params)
  } catch {
    return null
  }
  return showsEveryRequiredField(params, presentation) ? presentation : null
}

/** The card shows a few fields; accepting a form whose required field it cut off would send it incomplete. */
function showsEveryRequiredField(params: unknown, presentation: AcpRequestPresentation): boolean {
  const schema = readRecord(readRecord(params).requestedSchema)
  const properties = readRecord(schema.properties)
  const required = Array.isArray(schema.required) ? schema.required : []
  const requiredCount = new Set(
    required.filter((key) => typeof key === 'string' && Object.hasOwn(properties, key))
  ).size
  // Each shown required field is one question that can't be skipped.
  const shown =
    presentation.body.kind === 'question'
      ? (presentation.body.questions ?? []).filter((question) => !question.skippable).length
      : 0
  return shown === requiredCount
}
