// The Muse Session Protocol (MSP) v1 wire surface Orca speaks: the subset a
// structured chat needs. Field shapes follow `muse schema generate-json-schema`;
// the protocol is additive-open, so the client ignores what it does not model.

import { createHash } from 'node:crypto'

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export type MspClientInfo = {
  name: string
  version: string
}

export type MspInitializeResult = {
  sessionDurability?: string
  museHome?: string
  platformFamily?: string
  platformOs?: string
  serverInfo?: { name?: string; version?: string }
}

export type MspSessionStatus = string

export type MspSession = {
  sessionId: string
  status: MspSessionStatus
  workspaceRoot: string
  providerId: string
  modelId: string | null
  turnCount: number
}

export type MspTurnInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; base64Data: string; mediaType: string; width?: number; height?: number }

export type MspIfBusy = 'queue' | 'steer' | 'replace'

export type MspApprovalMode = 'allowAll' | 'promptUnmatched' | 'onRequest' | 'denyUnmatched'

export type MspItemKind =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoning'
  | 'toolCall'
  | 'userShell'
  | 'subagent'
  | 'workflow'
  | 'reminderChild'
  | 'compaction'
  | 'hookRun'
  | 'sideChat'
  | 'webSearch'
  | 'monitorFeed'
  | (string & {})

export type MspItemStatus = 'inProgress' | 'completed' | 'failed'

export type MspItem = {
  itemId: string
  kind: MspItemKind
  turnId?: string
  status?: MspItemStatus
  revision?: number
  text?: string
  displayText?: string
  failureReason?: string
  name?: string
  args?: string
  callId?: string
  output?: string
  background?: boolean
  command?: string
  approvalId?: string
}

export type MspViewCursor = string

export type MspItemEvent = {
  sessionId: string
  item: MspItem
  viewCursor?: MspViewCursor
}

export type MspItemDeltaEvent = {
  sessionId: string
  itemId: string
  field: string
  delta: string
  viewCursor?: MspViewCursor
}

export type MspTurnEvent = {
  sessionId: string
  turnId: string
  durationMs?: number
  viewCursor?: MspViewCursor
}

export type MspTokenUsageEvent = {
  sessionId: string
  turnId?: string
  totalTokens?: number
  promptTokens?: number
  outputTokens?: number
}

export type MspApprovalChoice = {
  choiceId: string
  label: string
  decision: string
}

export type MspApprovalRequest = {
  sessionId: string
  turnId: string
  approvalId: string
  requirementId?: string
  currentRequirementId?: string
  itemId: string
  toolCallId: string
  toolName: string
  subject?: string
  rawArgs?: string
  availableChoices: MspApprovalChoice[]
}

export type MspUserInputQuestion = {
  questionId: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

export type MspUserInputRequest = {
  sessionId: string
  turnId: string
  userInputId: string
  itemId: string
  questions: MspUserInputQuestion[]
}

export type MspUserInputAnswer = {
  questionId: string
  selectedLabel?: string
  selectedLabels?: string[]
  freeText?: string
}

export type MspModelCatalogEntry = {
  modelId: string
  displayLabel?: string
  description?: string
  isDefault?: boolean
  isActive?: boolean
  defaultReasoningEffort?: string
  reasoningEffortVariants?: string[]
  providerId?: string
  profileId?: string
}

export type MspSessionListEntry = Pick<
  MspSession,
  'sessionId' | 'status' | 'workspaceRoot' | 'providerId' | 'modelId' | 'turnCount'
> & {
  updatedAt?: string
  title?: string | null
  name?: string | null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
