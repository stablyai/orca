import { readRecord, readString as readRecordString } from './codex-item-field-readers'

/** Same test as Codex's own TUI: an MCP tool-call approval with no form fields to fill. */
export function isCodexMcpToolApproval(params: unknown): boolean {
  const record = readRecord(params)
  if (readRecordString(readRecord(record._meta), 'codex_approval_kind') !== 'mcp_tool_call') {
    return false
  }
  if (
    record.mode !== undefined &&
    record.mode !== 'form' &&
    record.mode !== 'openai/form' &&
    record.mode !== 'openaiForm'
  ) {
    return false
  }
  const schema = record.requestedSchema
  if (schema === undefined || schema === null) {
    return true
  }
  const properties = readRecord(schema).properties
  return (
    readRecord(schema).type === 'object' &&
    typeof properties === 'object' &&
    properties !== null &&
    !Array.isArray(properties) &&
    Object.keys(properties).length === 0
  )
}

export type CodexMcpToolApprovalDecision = 'accept' | 'acceptForSession' | 'cancel'

/** Codex's TUI offers no Deny for a tool call, and session reuse only when the request allows it. */
export function codexMcpToolApprovalDecisions(params: unknown): CodexMcpToolApprovalDecision[] {
  const persist = readRecord(readRecord(params)._meta).persist
  const persistsSession = Array.isArray(persist)
    ? persist.includes('session')
    : persist === 'session'
  return persistsSession ? ['accept', 'acceptForSession', 'cancel'] : ['accept', 'cancel']
}
