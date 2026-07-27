import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { MobileTerminalTheme } from '../terminal/terminal-webview-contract'

type AgentStateHistoryEntry = AgentStatusEntry['stateHistory'][number]
type AgentOrchestration = NonNullable<AgentStatusEntry['orchestration']>
type AgentProviderSession = NonNullable<AgentStatusEntry['providerSession']>
type TerminalThemeColors = MobileTerminalTheme['theme']

// Why: mobile snapshots contain fresh object identities, so field coverage must
// stay exhaustive without falling back to allocating serialized copies every 2s.
const AGENT_STATUS_FIELD_COVERAGE = {
  state: true,
  prompt: true,
  updatedAt: true,
  stateStartedAt: true,
  agentType: true,
  paneKey: true,
  terminalHandle: true,
  worktreeId: true,
  tabId: true,
  terminalTitle: true,
  stateHistory: true,
  toolName: true,
  toolInput: true,
  interactivePrompt: true,
  lastAssistantMessage: true,
  interrupted: true,
  orchestration: true,
  providerSession: true
} satisfies { [K in keyof AgentStatusEntry]-?: true }

const AGENT_STATE_HISTORY_FIELD_COVERAGE = {
  state: true,
  prompt: true,
  startedAt: true,
  interrupted: true
} satisfies { [K in keyof AgentStateHistoryEntry]-?: true }

const AGENT_ORCHESTRATION_FIELD_COVERAGE = {
  taskId: true,
  dispatchId: true,
  taskTitle: true,
  displayName: true,
  parentTerminalHandle: true,
  parentPaneKey: true,
  coordinatorHandle: true,
  orchestrationRunId: true
} satisfies { [K in keyof AgentOrchestration]-?: true }

const AGENT_PROVIDER_SESSION_FIELD_COVERAGE = {
  key: true,
  id: true,
  transcriptPath: true
} satisfies { [K in keyof AgentProviderSession]-?: true }

const TERMINAL_THEME_COLOR_FIELD_COVERAGE = {
  foreground: true,
  background: true,
  cursor: true,
  cursorAccent: true,
  selectionBackground: true,
  selectionForeground: true,
  black: true,
  red: true,
  green: true,
  yellow: true,
  blue: true,
  magenta: true,
  cyan: true,
  white: true,
  brightBlack: true,
  brightRed: true,
  brightGreen: true,
  brightYellow: true,
  brightBlue: true,
  brightMagenta: true,
  brightCyan: true,
  brightWhite: true,
  bold: true
} satisfies { [K in keyof TerminalThemeColors]-?: true }

const AGENT_STATUS_FIELDS = Object.keys(AGENT_STATUS_FIELD_COVERAGE) as (keyof AgentStatusEntry)[]
const AGENT_STATE_HISTORY_FIELDS = Object.keys(
  AGENT_STATE_HISTORY_FIELD_COVERAGE
) as (keyof AgentStateHistoryEntry)[]
const AGENT_ORCHESTRATION_FIELDS = Object.keys(
  AGENT_ORCHESTRATION_FIELD_COVERAGE
) as (keyof AgentOrchestration)[]
const AGENT_PROVIDER_SESSION_FIELDS = Object.keys(
  AGENT_PROVIDER_SESSION_FIELD_COVERAGE
) as (keyof AgentProviderSession)[]
const TERMINAL_THEME_COLOR_FIELDS = Object.keys(
  TERMINAL_THEME_COLOR_FIELD_COVERAGE
) as (keyof TerminalThemeColors)[]

function recordsMatchOnFields<T extends object>(
  a: T | null | undefined,
  b: T | null | undefined,
  fields: readonly (keyof T)[]
): boolean {
  if (a === b) {
    return true
  }
  if (a == null || b == null) {
    return false
  }
  for (const field of fields) {
    if (a[field] !== b[field]) {
      return false
    }
  }
  return true
}

function agentStateHistoriesEqual(
  a: AgentStatusEntry['stateHistory'] | null | undefined,
  b: AgentStatusEntry['stateHistory'] | null | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (a == null || b == null || a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!recordsMatchOnFields(a[index], b[index], AGENT_STATE_HISTORY_FIELDS)) {
      return false
    }
  }
  return true
}

export function agentStatusEntriesEqual(
  a: AgentStatusEntry | null | undefined,
  b: AgentStatusEntry | null | undefined
): boolean {
  if (a === b || (a == null && b == null)) {
    return true
  }
  if (a == null || b == null) {
    return false
  }
  for (const field of AGENT_STATUS_FIELDS) {
    if (field === 'stateHistory' || field === 'orchestration' || field === 'providerSession') {
      continue
    }
    if (a[field] !== b[field]) {
      return false
    }
  }
  return (
    agentStateHistoriesEqual(a.stateHistory, b.stateHistory) &&
    recordsMatchOnFields(a.orchestration, b.orchestration, AGENT_ORCHESTRATION_FIELDS) &&
    recordsMatchOnFields(a.providerSession, b.providerSession, AGENT_PROVIDER_SESSION_FIELDS)
  )
}

export function terminalThemesEqual(
  a: MobileTerminalTheme | null | undefined,
  b: MobileTerminalTheme | null | undefined
): boolean {
  if (a === b || (a == null && b == null)) {
    return true
  }
  return (
    a != null &&
    b != null &&
    a.mode === b.mode &&
    recordsMatchOnFields(a.theme, b.theme, TERMINAL_THEME_COLOR_FIELDS)
  )
}
