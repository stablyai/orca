import {
  codexMcpToolApprovalDecisions,
  isCodexMcpToolApproval,
  type CodexMcpToolApprovalDecision
} from './codex-mcp-tool-approval'
import {
  codexJournalPromptIdPart,
  codexPromptTurnIdentity,
  readQuestionIds,
  readQuestionOptionAnswers
} from './codex-prompt-registry-bounds'
import { readRecord, readString as readRecordString } from './codex-item-field-readers'
import { readCodexMcpElicitation, type CodexMcpElicitation } from './codex-mcp-elicitation'

export const CODEX_COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval'
export const CODEX_FILE_CHANGE_APPROVAL_METHOD = 'item/fileChange/requestApproval'
export const CODEX_USER_INPUT_METHOD = 'item/tool/requestUserInput'
export const CODEX_MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request'

export type CodexPendingPrompt = {
  requestId: number | string
  method: string
  threadId: string
  turnId: string | null
  /** Oversized turn IDs stay comparable within the registry byte cap. */
  turnIdDigest?: string
  codexItemId: string
  /** Prefer approvalId for repeated requests from one tool item. */
  promptKey: string
  questionIds: readonly string[]
  questionIdAliases: ReadonlyMap<string, string>
  optionAnswers: ReadonlyMap<string, { questionId: string; answer: string }>
  answers: Map<string, string>
  journalRows: ReadonlyMap<string, string | null>
  requestFingerprint: string
  /** Set when the request limits the decisions, so an unoffered one is refused. */
  offeredDecisions?: readonly (CodexMcpToolApprovalDecision | 'decline')[]
  elicitation?: CodexMcpElicitation
}

function readString(params: unknown, key: string): string | null {
  return readRecordString(readRecord(params), key)
}

export function isCodexPromptMethod(method: string): boolean {
  return (
    method === CODEX_COMMAND_APPROVAL_METHOD ||
    method === CODEX_FILE_CHANGE_APPROVAL_METHOD ||
    method === CODEX_USER_INPUT_METHOD ||
    method === CODEX_MCP_ELICITATION_METHOD
  )
}

/** A fresh registry id fences elicitation request ids reused after app-server restart. */
function readPromptItemId(
  request: { id: number | string; method: string; params: unknown },
  registryId: string,
  supportedElicitation: boolean
) {
  if (request.method === CODEX_MCP_ELICITATION_METHOD) {
    // Turn-less approvals escape turn stop and cleanup, so they keep the safe decline.
    return supportedElicitation && readString(request.params, 'turnId')
      ? `mcp-elicitation:${registryId}:${request.id}`
      : null
  }
  return readString(request.params, 'itemId')
}

export function readCodexPendingPrompt(
  request: {
    id: number | string
    method: string
    params: unknown
  },
  registryId: string
): CodexPendingPrompt | null {
  const isMcpElicitation = request.method === CODEX_MCP_ELICITATION_METHOD
  const toolApproval = isMcpElicitation && isCodexMcpToolApproval(request.params)
  const elicitation =
    isMcpElicitation && !toolApproval ? readCodexMcpElicitation(request.params) : null
  const codexItemId = readPromptItemId(request, registryId, toolApproval || elicitation !== null)
  const threadId = readString(request.params, 'threadId')
  if (!isCodexPromptMethod(request.method) || !codexItemId || !threadId) {
    return null
  }
  const questionIds =
    request.method === CODEX_USER_INPUT_METHOD ? readQuestionIds(request.params) : []
  if (questionIds === null) {
    return null
  }
  const optionAnswers =
    request.method === CODEX_USER_INPUT_METHOD
      ? readQuestionOptionAnswers(request.params)
      : new Map<string, { questionId: string; answer: string }>()
  if (optionAnswers === null) {
    return null
  }
  const turnId = readString(request.params, 'turnId')
  const turnIdentity = turnId ? codexPromptTurnIdentity(turnId) : { turnId: null }
  if (turnId && turnIdentity.turnId === null) {
    return null
  }
  const prompt: CodexPendingPrompt = {
    requestId: request.id,
    method: request.method,
    threadId,
    ...turnIdentity,
    codexItemId,
    promptKey: isMcpElicitation
      ? codexItemId
      : (readString(request.params, 'approvalId') ?? codexItemId),
    ...(isMcpElicitation
      ? {
          offeredDecisions: elicitation
            ? elicitation.kind === 'form'
              ? (['decline', 'cancel'] as const)
              : (['accept', 'decline', 'cancel'] as const)
            : codexMcpToolApprovalDecisions(request.params)
        }
      : {}),
    ...(elicitation ? { elicitation } : {}),
    questionIds,
    questionIdAliases:
      request.method === CODEX_USER_INPUT_METHOD
        ? new Map(questionIds.map((id) => [codexJournalPromptIdPart(id), id]))
        : new Map(),
    optionAnswers,
    answers: new Map(),
    journalRows: new Map(),
    requestFingerprint: ''
  }
  return prompt
}
