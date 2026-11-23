import type { AcpRequestPresentation } from '../../../acp/acp-dialects/acp-dialect'
import { acpFormElicitationPresentation } from '../../../acp/requests/acp-form-elicitation'
import { isCodexMcpToolApproval } from './codex-mcp-tool-approval'

/** An MCP server's own form, on the question card ACP forms use; null for a tool-call approval or a form Orca can't show. */
export function codexMcpFormPresentation(params: unknown): AcpRequestPresentation | null {
  if (isCodexMcpToolApproval(params)) {
    return null
  }
  try {
    return acpFormElicitationPresentation(params)
  } catch {
    return null
  }
}
