import { formatAgentTypeLabel } from '../../shared/agent-type-label'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'

type NotificationTranslator = (key: string, fallback: string) => string

const englishNotificationCopy: NotificationTranslator = (_key, fallback) => fallback

const NOTIFICATION_AGENT_LABEL_MAX_LENGTH = 40
const NOTIFICATION_TITLE_CONTEXT_MAX_LENGTH = 80
const NOTIFICATION_BODY_PREVIEW_MAX_LENGTH = 180

export function buildNotificationOptions(
  args: NotificationDispatchRequest,
  translate: NotificationTranslator = englishNotificationCopy
): {
  title: string
  body: string
  silent?: boolean
} {
  if (args.source === 'terminal-bell') {
    const attention = translate('notifications.bell.attentionRequested', 'Attention requested')
    return {
      title: fillNotificationPlaceholders(
        translate('notifications.bell.title', 'Bell in {{worktree}}'),
        { worktree: args.worktreeLabel ?? translateWorkspace(translate) }
      ),
      body: args.repoLabel ? `${args.repoLabel} · ${attention}` : attention
    }
  }

  if (args.source === 'test') {
    return {
      title: translate('notifications.test.title', 'Orca notifications are on'),
      body: translate('notifications.test.body', 'This is a test notification from Orca.')
    }
  }

  const richOptions = buildAgentTaskCompleteNotificationOptions(args, translate)
  if (richOptions) {
    return richOptions
  }

  return buildAgentTaskCompleteFallbackNotificationOptions(args, translate)
}

function translateWorkspace(translate: NotificationTranslator): string {
  return translate('notifications.workspaceFallback', 'workspace')
}

// Fill after translating: headless, pre-init and wrapped translators only map keys to templates.
function fillNotificationPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? values[name] : placeholder
  )
}

function buildAgentTaskCompleteNotificationOptions(
  args: NotificationDispatchRequest,
  translate: NotificationTranslator
): { title: string; body: string } | null {
  if (!hasAgentNotificationSnapshot(args)) {
    return null
  }

  const agentLabel = formatNotificationAgentLabel(args.agentType)
  const worktreeContext = formatNotificationWorktreeContext(args, translate)
  const statusText = formatAgentNotificationStatusText(args, translate)

  return {
    title: `${worktreeContext} - ${agentLabel} ${statusText}`,
    body: buildAgentTaskCompleteRichBody(args, translate) ?? `${agentLabel} ${statusText}.`
  }
}

// Announce finished only for proved terminal state or an expired snapshot's completion signal (#4375).
function formatAgentNotificationStatusText(
  args: NotificationDispatchRequest,
  translate: NotificationTranslator
): string {
  if (args.agentState === 'blocked' || args.agentState === 'waiting') {
    return translate('notifications.agentStatus.needsInput', 'needs input')
  }
  if (args.agentState === 'working') {
    return translate('notifications.agentStatus.working', 'working')
  }
  if (args.agentState !== 'done') {
    return translate('notifications.agentStatus.finished', 'finished')
  }
  switch (args.agentTurnOutcome) {
    // A turn cut short by anything but the user is a fault, as a failure is.
    case 'failure':
    case 'interruption':
      return translate('notifications.agentStatus.failed', 'failed')
    // User stops, supersession and unproved endings must not read as finished.
    case 'cancellation':
    case 'superseded':
    case 'unconfirmed':
      return translate('notifications.agentStatus.stopped', 'stopped')
    case 'success':
    case undefined:
      return translate('notifications.agentStatus.finished', 'finished')
  }
}

function formatNotificationWorktreeContext(
  args: NotificationDispatchRequest,
  translate: NotificationTranslator
): string {
  const worktreeLabel = normalizeNotificationText(
    args.worktreeLabel,
    NOTIFICATION_TITLE_CONTEXT_MAX_LENGTH
  )
  const repoLabel = normalizeNotificationText(args.repoLabel, NOTIFICATION_TITLE_CONTEXT_MAX_LENGTH)
  if (repoLabel && worktreeLabel) {
    return normalizeNotificationText(
      `${repoLabel} / ${worktreeLabel}`,
      NOTIFICATION_TITLE_CONTEXT_MAX_LENGTH
    )
  }
  return worktreeLabel || repoLabel || translateWorkspace(translate)
}

function hasAgentNotificationSnapshot(args: NotificationDispatchRequest): boolean {
  return Boolean(
    args.agentType ||
    args.agentState ||
    args.agentPrompt ||
    args.agentToolName ||
    args.agentToolInput ||
    args.agentLastAssistantMessage ||
    args.agentTurnOutcome !== undefined
  )
}

function buildAgentTaskCompleteRichBody(
  args: NotificationDispatchRequest,
  translate: NotificationTranslator
): string | null {
  const assistantMessage = normalizeNotificationText(
    args.agentLastAssistantMessage,
    NOTIFICATION_BODY_PREVIEW_MAX_LENGTH
  )
  if (assistantMessage) {
    return assistantMessage
  }

  const toolName = normalizeNotificationText(args.agentToolName, 60)
  const toolInput = normalizeNotificationText(
    args.agentToolInput,
    NOTIFICATION_BODY_PREVIEW_MAX_LENGTH
  )
  if (toolName && toolInput) {
    return fillNotificationPlaceholders(
      translate('notifications.agentTool.usingWithInput', 'Using {{tool}}: {{input}}'),
      { tool: toolName, input: toolInput }
    )
  }
  if (toolName) {
    return fillNotificationPlaceholders(
      translate('notifications.agentTool.using', 'Using {{tool}}'),
      { tool: toolName }
    )
  }
  if (toolInput) {
    return fillNotificationPlaceholders(
      translate('notifications.agentTool.input', 'Tool input: {{input}}'),
      { input: toolInput }
    )
  }

  return null
}

function buildAgentTaskCompleteFallbackNotificationOptions(
  args: NotificationDispatchRequest,
  translate: NotificationTranslator
): {
  title: string
  body: string
} {
  return {
    title: fillNotificationPlaceholders(
      translate('notifications.taskComplete.title', 'Task complete in {{worktree}}'),
      { worktree: args.worktreeLabel ?? translateWorkspace(translate) }
    ),
    body: buildAgentTaskCompleteFallbackBody(args, translate)
  }
}

function buildAgentTaskCompleteFallbackBody(
  args: NotificationDispatchRequest,
  translate: NotificationTranslator
): string {
  return args.repoLabel
    ? `${args.repoLabel}${args.terminalTitle ? ` · ${args.terminalTitle}` : ''}`
    : (args.terminalTitle ??
        translate('notifications.taskComplete.body', 'A coding agent finished working.'))
}

function formatNotificationAgentLabel(agentType: string | null | undefined): string {
  return formatAgentTypeLabel(
    normalizeNotificationText(agentType, NOTIFICATION_AGENT_LABEL_MAX_LENGTH)
  )
}

function normalizeNotificationText(value: string | null | undefined, maxLength: number): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (normalized.length <= maxLength) {
    return normalized
  }
  const truncated = normalized.slice(0, maxLength - 1)
  const lastCode = truncated.charCodeAt(truncated.length - 1)
  const safeTruncated =
    lastCode >= 0xd800 && lastCode <= 0xdbff ? truncated.slice(0, -1) : truncated
  return `${safeTruncated}…`
}
