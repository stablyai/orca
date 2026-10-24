import type { CodexAppServerNotificationMethod } from '../../codex/codex-app-server-notification-schema'
import { CODEX_SUBAGENT_ITEM_TYPE } from '../../codex/codex-subagent-activity'
import { isProviderRecord } from '../../provider-process/provider-json-record'
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
    // Goal frames are the only authoritative evidence because goal calls are never emitted as items.
    'thread/goal/updated': 'timeline-substantive',
    'thread/goal/cleared': 'timeline-substantive',
    'thread/environment/connected': 'status-chrome',
    'thread/environment/disconnected': 'status-chrome',
    'thread/settings/updated': 'status-chrome',
    'thread/tokenUsage/updated': 'status-chrome',
    'turn/started': 'status-chrome',
    'hook/started': 'suppressed-benign',
    'turn/completed': 'status-chrome',
    // Failed hooks surface below; prompt refusal already has its own row.
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
    'thread/compacted': 'timeline-substantive',
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
    'message:stream_event:ping': 'suppressed-benign',
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
    // Informational/hook warnings render through claude-informational-row.
    'message:system:informational': 'status-chrome',
    'message:conversation_reset': 'status-chrome',
    // Command UUID lifecycle is bookkeeping absent from Claude’s own transcript.
    'message:command_lifecycle': 'status-chrome',
    // Result failures depend on turn outcome; result journaling supplies that verdict.
    'message:result:success': 'status-chrome',
    'message:result:error_during_execution': 'status-chrome',
    'message:result:error_max_turns': 'status-chrome',
    'message:result:error_max_budget_usd': 'status-chrome',
    'message:result:error_max_structured_output_retries': 'status-chrome'
  }
} as const satisfies ProviderFrameClassificationTable

/** Item-type keys bypass the method catalog, so classify them separately. */
const CODEX_ITEM_CLASSIFICATIONS: Record<string, ProviderFrameClassification> = {
  // Coalesce canonical and legacy compaction completions.
  contextCompaction: 'timeline-substantive',
  // Restore replays lifecycle items here; the roster already renders them. Keep collabAgentToolCall
  // visible because some Codex sessions report fan-out only through those calls.
  [CODEX_SUBAGENT_ITEM_TYPE]: 'status-chrome',
  // Sleep contains only ID/duration; no transcript content.
  sleep: 'status-chrome'
}

function notificationKind(kind: string): string {
  return kind.startsWith('notification:') ? kind.slice('notification:'.length) : kind
}

function itemKind(kind: string): string | null {
  return kind.startsWith('item:') ? kind.slice('item:'.length) : null
}

export function isDeltaProviderFrameKind(kind: string): boolean {
  return notificationKind(kind).toLowerCase().endsWith('delta')
}

const CODEX_NOTIFICATION_CLASSIFICATIONS: Readonly<Record<string, ProviderFrameClassification>> =
  PROVIDER_FRAME_CLASSIFICATIONS.codex
const CLAUDE_FRAME_CLASSIFICATIONS: Readonly<Record<string, ProviderFrameClassification>> =
  PROVIDER_FRAME_CLASSIFICATIONS.claude

/** Classify failures only from declared kinds/outcome fields; nested statuses can describe unrelated work.
 * Unlisted frames retain visible fallback rows. */
const PROVIDER_FRAME_CATALOGS: ReadonlyMap<
  string,
  (kind: string, payload: unknown) => ProviderFrameClassification | undefined
> = new Map<
  keyof ProviderFrameClassificationTable,
  (kind: string, payload: unknown) => ProviderFrameClassification | undefined
>([
  [
    'codex',
    (kind, payload) => {
      const item = itemKind(kind)
      if (item !== null) {
        return CODEX_ITEM_CLASSIFICATIONS[item]
      }
      const method = notificationKind(kind)
      if (method === 'hook/completed') {
        const run = isProviderRecord(payload) && isProviderRecord(payload.run) ? payload.run : null
        return run?.status === 'failed' ? 'error-surface' : 'suppressed-benign'
      }
      return CODEX_NOTIFICATION_CLASSIFICATIONS[method]
    }
  ],
  [
    'claude',
    (kind, payload) => {
      if (kind === 'message:result') {
        const subtype = isProviderRecord(payload) ? payload.subtype : undefined
        return subtype === 'success' ? 'status-chrome' : 'error-surface'
      }
      if (kind === 'message:system:hook_response') {
        return isProviderRecord(payload) && payload.outcome === 'error'
          ? 'error-surface'
          : 'suppressed-benign'
      }
      if (kind === 'message:auth_status') {
        const error = isProviderRecord(payload) ? payload.error : undefined
        return typeof error === 'string' && error.trim().length > 0
          ? 'error-surface'
          : 'status-chrome'
      }
      return CLAUDE_FRAME_CLASSIFICATIONS[kind]
    }
  ]
])

export function classifyProviderFrame(
  provider: string,
  kind: string,
  payload: unknown
): ProviderFrameClassification {
  if (isDeltaProviderFrameKind(kind)) {
    return 'stream-into-item'
  }
  return PROVIDER_FRAME_CATALOGS.get(provider)?.(kind, payload) ?? 'timeline-substantive'
}
