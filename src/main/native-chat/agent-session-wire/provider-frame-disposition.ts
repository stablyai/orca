import type { CodexAppServerNotificationMethod } from '../../codex/codex-app-server-notification-schema'
import type { ClaudeStreamJsonFrameKind } from './claude-stream-json-frame-schema'

export type ProviderFrameClassification =
  | 'timeline-substantive'
  | 'stream-into-item'
  | 'status-chrome'
  | 'suppressed-benign'
  | 'error-surface'

type ProviderFrameClassificationTable = {
  codex: Record<CodexAppServerNotificationMethod, ProviderFrameClassification>
  claude: Record<ClaudeStreamJsonFrameKind, ProviderFrameClassification>
}

export const PROVIDER_FRAME_CLASSIFICATIONS = {
  codex: {
    error: 'error-surface',
    'thread/started': 'status-chrome',
    'thread/status/changed': 'status-chrome',
    'thread/archived': 'status-chrome',
    'thread/deleted': 'status-chrome',
    'thread/unarchived': 'status-chrome',
    'thread/closed': 'status-chrome',
    'skills/changed': 'status-chrome',
    'thread/name/updated': 'status-chrome',
    'thread/goal/updated': 'status-chrome',
    'thread/goal/cleared': 'status-chrome',
    'thread/environment/connected': 'status-chrome',
    'thread/environment/disconnected': 'status-chrome',
    'thread/settings/updated': 'status-chrome',
    'thread/tokenUsage/updated': 'status-chrome',
    'turn/started': 'status-chrome',
    'hook/started': 'suppressed-benign',
    'turn/completed': 'status-chrome',
    'hook/completed': 'suppressed-benign',
    'turn/diff/updated': 'suppressed-benign',
    'turn/plan/updated': 'timeline-substantive',
    'item/started': 'timeline-substantive',
    'item/autoApprovalReview/started': 'status-chrome',
    'item/autoApprovalReview/completed': 'status-chrome',
    'item/completed': 'timeline-substantive',
    'rawResponseItem/completed': 'suppressed-benign',
    'rawResponse/completed': 'suppressed-benign',
    'item/agentMessage/delta': 'stream-into-item',
    'item/plan/delta': 'stream-into-item',
    'command/exec/outputDelta': 'stream-into-item',
    'process/outputDelta': 'stream-into-item',
    'process/exited': 'timeline-substantive',
    'item/commandExecution/outputDelta': 'stream-into-item',
    'item/commandExecution/terminalInteraction': 'stream-into-item',
    'item/fileChange/outputDelta': 'stream-into-item',
    'item/fileChange/patchUpdated': 'stream-into-item',
    'serverRequest/resolved': 'suppressed-benign',
    'item/mcpToolCall/progress': 'status-chrome',
    'mcpServer/oauthLogin/completed': 'status-chrome',
    'mcpServer/startupStatus/updated': 'status-chrome',
    'account/updated': 'status-chrome',
    'account/rateLimits/updated': 'suppressed-benign',
    'app/list/updated': 'status-chrome',
    'remoteControl/status/changed': 'status-chrome',
    'externalAgentConfig/import/progress': 'status-chrome',
    'externalAgentConfig/import/completed': 'status-chrome',
    'fs/changed': 'suppressed-benign',
    'item/reasoning/summaryTextDelta': 'stream-into-item',
    'item/reasoning/summaryPartAdded': 'stream-into-item',
    'item/reasoning/textDelta': 'stream-into-item',
    'thread/compacted': 'status-chrome',
    'model/rerouted': 'status-chrome',
    'model/verification': 'status-chrome',
    'turn/moderationMetadata': 'suppressed-benign',
    'model/safetyBuffering/updated': 'status-chrome',
    warning: 'error-surface',
    guardianWarning: 'error-surface',
    deprecationNotice: 'error-surface',
    configWarning: 'error-surface',
    'fuzzyFileSearch/sessionUpdated': 'suppressed-benign',
    'fuzzyFileSearch/sessionCompleted': 'suppressed-benign',
    'thread/realtime/started': 'status-chrome',
    'thread/realtime/itemAdded': 'timeline-substantive',
    'thread/realtime/transcript/delta': 'stream-into-item',
    'thread/realtime/transcript/done': 'timeline-substantive',
    'thread/realtime/outputAudio/delta': 'stream-into-item',
    'thread/realtime/sdp': 'suppressed-benign',
    'thread/realtime/error': 'error-surface',
    'thread/realtime/closed': 'status-chrome',
    'windows/worldWritableWarning': 'error-surface',
    'windowsSandbox/setupCompleted': 'status-chrome',
    'account/login/completed': 'status-chrome'
  },
  claude: {
    'message:assistant': 'timeline-substantive',
    'message:user': 'timeline-substantive',
    'message:result': 'status-chrome',
    'message:system:init': 'status-chrome',
    'message:stream_event:message_start': 'status-chrome',
    'message:stream_event:message_delta': 'stream-into-item',
    'message:stream_event:message_stop': 'status-chrome',
    'message:stream_event:content_block_start': 'status-chrome',
    'message:stream_event:content_block_delta': 'stream-into-item',
    'message:stream_event:content_block_stop': 'status-chrome',
    'message:system:compact_boundary': 'status-chrome',
    'message:system:status': 'status-chrome',
    'message:system:api_retry': 'status-chrome',
    'message:system:control_request_progress': 'status-chrome',
    'message:system:model_refusal_fallback': 'status-chrome',
    'message:system:model_refusal_no_fallback': 'error-surface',
    'message:system:local_command_output': 'timeline-substantive',
    'message:system:hook_started': 'suppressed-benign',
    'message:system:hook_progress': 'suppressed-benign',
    'message:system:hook_response': 'suppressed-benign',
    'message:system:plugin_install': 'status-chrome',
    'message:tool_progress': 'status-chrome',
    'message:auth_status': 'status-chrome',
    'message:system:task_notification': 'status-chrome',
    'message:system:task_started': 'status-chrome',
    'message:system:task_updated': 'status-chrome',
    'message:system:task_progress': 'status-chrome',
    'message:system:background_tasks_changed': 'status-chrome',
    'message:system:thinking_tokens': 'status-chrome',
    'message:system:session_state_changed': 'status-chrome',
    'message:system:worker_shutting_down': 'status-chrome',
    'message:system:commands_changed': 'status-chrome',
    'message:system:notification': 'status-chrome',
    'message:system:files_persisted': 'status-chrome',
    'message:tool_use_summary': 'timeline-substantive',
    'message:system:memory_recall': 'timeline-substantive',
    'message:rate_limit_event': 'status-chrome',
    'message:system:elicitation_complete': 'status-chrome',
    'message:system:permission_denied': 'error-surface',
    'message:prompt_suggestion': 'status-chrome',
    'message:system:mirror_error': 'error-surface',
    'message:system:informational': 'timeline-substantive',
    'message:conversation_reset': 'status-chrome'
  }
} as const satisfies ProviderFrameClassificationTable

const ERROR_VARIANT_KEYS = new Set(['type', 'status', 'state', 'subtype', 'outcome'])
const ERROR_VALUE_KEYS = new Set(['error', 'failureReason', 'failure_reason'])

function isErrorVariant(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const normalized = value.replace(/[_\s-]/g, '').toLowerCase()
  return (
    normalized.startsWith('error') || normalized.startsWith('fail') || normalized === 'systemerror'
  )
}

function hasProviderError(payload: unknown): boolean {
  const pending = [payload]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      continue
    }
    seen.add(value)
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    for (const [key, nested] of Object.entries(value)) {
      if ((key === 'isError' || key === 'is_error') && nested === true) {
        return true
      }
      if (key === 'success' && nested === false) {
        return true
      }
      if (ERROR_VARIANT_KEYS.has(key) && isErrorVariant(nested)) {
        return true
      }
      if (ERROR_VALUE_KEYS.has(key) && nested !== null && nested !== false && nested !== '') {
        return true
      }
      pending.push(nested)
    }
  }
  return false
}

/** Codex thread-item types with no typed renderer, dispositioned by hand so a
 *  new item type cannot leak `codex · item:<type>` into the transcript. The
 *  notification catalog above is keyed by METHOD and never matches these. */
const CODEX_ITEM_CLASSIFICATIONS: Record<string, ProviderFrameClassification> = {
  // The `thread/compacted` notification is already chrome; its item form is the
  // same event and must not read as a mysterious opcode row.
  contextCompaction: 'status-chrome'
}

function notificationKind(kind: string): string {
  return kind.startsWith('notification:') ? kind.slice('notification:'.length) : kind
}

function itemKind(kind: string): string | null {
  return kind.startsWith('item:') ? kind.slice('item:'.length) : null
}

export function isDeltaShapedProviderFrameKind(kind: string): boolean {
  return notificationKind(kind).toLowerCase().endsWith('delta')
}

function catalogClassification(
  provider: string,
  kind: string
): ProviderFrameClassification | undefined {
  if (provider === 'codex') {
    const item = itemKind(kind)
    if (item !== null) {
      return CODEX_ITEM_CLASSIFICATIONS[item]
    }
    return PROVIDER_FRAME_CLASSIFICATIONS.codex[
      notificationKind(kind) as CodexAppServerNotificationMethod
    ]
  }
  if (provider === 'claude') {
    return PROVIDER_FRAME_CLASSIFICATIONS.claude[kind as ClaudeStreamJsonFrameKind]
  }
  return undefined
}

export function classifyProviderFrame(
  provider: string,
  kind: string,
  payload: unknown
): ProviderFrameClassification {
  // Payload failure inspection outranks the name-shape heuristic below: an
  // unknown frame that reports an error must reach the user even when its
  // method name happens to look like a stream delta.
  if (hasProviderError(payload)) {
    return 'error-surface'
  }
  if (isDeltaShapedProviderFrameKind(kind)) {
    return 'stream-into-item'
  }
  if (provider === 'claude' && kind === 'message:result') {
    const subtype =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>).subtype
        : undefined
    return subtype === 'success' ? 'status-chrome' : 'error-surface'
  }
  return catalogClassification(provider, kind) ?? 'timeline-substantive'
}
