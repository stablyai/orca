import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'

type NotificationStatusTranslator = (
  key: string,
  fallback: string,
  values?: Record<string, string>
) => string

// Why: headless hosts have no catalog, but their English copy still carries {{placeholders}}.
const englishNotificationStatus: NotificationStatusTranslator = (_key, fallback, values) =>
  values
    ? fallback.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => values[name] ?? placeholder)
    : fallback

const NOTIFICATION_AGENT_LABEL_MAX_LENGTH = 40
const NOTIFICATION_TITLE_CONTEXT_MAX_LENGTH = 80
const NOTIFICATION_BODY_PREVIEW_MAX_LENGTH = 180

const AGENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  aider: 'Aider',
  pi: 'Pi',
  omp: 'OMP',
  droid: 'Droid',
  grok: 'Grok',
  hermes: 'Hermes'
}

export function buildNotificationOptions(
  args: NotificationDispatchRequest,
  translate: NotificationStatusTranslator = englishNotificationStatus
): {
  title: string
  body: string
  silent?: boolean
  sound?: string
} {
  if (args.source === 'terminal-bell') {
    const attention = translate('notifications.bell.attentionRequested', 'Attention requested')
    return {
      title: translate('notifications.bell.title', 'Bell in {{worktree}}', {
        worktree: args.worktreeLabel ?? translateWorkspace(translate)
      }),
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

function translateWorkspace(translate: NotificationStatusTranslator): string {
  return translate('notifications.workspaceFallback', 'workspace')
}

function buildAgentTaskCompleteNotificationOptions(
  args: NotificationDispatchRequest,
  translate: NotificationStatusTranslator
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

// Why (#4375): a still-working agent must never be announced as finished. Only an
// explicit terminal state, or no state at all (the hook snapshot expired and the
// notification itself is the completion signal), may say "finished".
function formatAgentNotificationStatusText(
  args: NotificationDispatchRequest,
  translate: NotificationStatusTranslator
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
    // Why: a Stop the user asked for, a turn a newer request replaced, or an end Orca cannot
    // prove, still never reads finished.
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
  translate: NotificationStatusTranslator
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
  translate: NotificationStatusTranslator
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
    return translate('notifications.agentTool.usingWithInput', 'Using {{tool}}: {{input}}', {
      tool: toolName,
      input: toolInput
    })
  }
  if (toolName) {
    return translate('notifications.agentTool.using', 'Using {{tool}}', { tool: toolName })
  }
  if (toolInput) {
    return translate('notifications.agentTool.input', 'Tool input: {{input}}', { input: toolInput })
  }

  return null
}

function buildAgentTaskCompleteFallbackNotificationOptions(
  args: NotificationDispatchRequest,
  translate: NotificationStatusTranslator
): {
  title: string
  body: string
} {
  return {
    title: translate('notifications.taskComplete.title', 'Task complete in {{worktree}}', {
      worktree: args.worktreeLabel ?? translateWorkspace(translate)
    }),
    body: buildAgentTaskCompleteFallbackBody(args, translate)
  }
}

function buildAgentTaskCompleteFallbackBody(
  args: NotificationDispatchRequest,
  translate: NotificationStatusTranslator
): string {
  return args.repoLabel
    ? `${args.repoLabel}${args.terminalTitle ? ` · ${args.terminalTitle}` : ''}`
    : (args.terminalTitle ??
        translate('notifications.taskComplete.body', 'A coding agent finished working.'))
}

function formatNotificationAgentLabel(agentType: string | null | undefined): string {
  const normalized = normalizeNotificationText(agentType, NOTIFICATION_AGENT_LABEL_MAX_LENGTH)
  if (!normalized || normalized === 'unknown') {
    return 'Agent'
  }
  return AGENT_TYPE_LABELS[normalized] ?? normalized
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
