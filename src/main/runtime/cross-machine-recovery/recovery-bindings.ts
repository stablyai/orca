import {
  RESUMABLE_TUI_AGENTS,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import type {
  RecoveryAgentBinding,
  RecoveryLaunchPreferences,
  RecoveryProviderSession
} from '../../../shared/cross-machine-recovery-descriptor'
import { parsePaneKey } from '../../../shared/stable-pane-id'

export type StructuredRecoveryRecord = { record: AgentSessionRecord; tabId: string }

export type RecoveryBindingSources = {
  worktreeId: string
  now: number
  liveStatuses: readonly AgentStatusIpcPayload[]
  sleepingRecords: readonly SleepingAgentSessionRecord[]
  structuredRecords: readonly StructuredRecoveryRecord[]
}

const LIVENESS_RANK: Record<RecoveryAgentBinding['liveness'], number> = {
  live: 2,
  sleeping: 1,
  exited: 0
}

const LAUNCH_PREFERENCE_KEYS = ['model', 'effort', 'mode'] as const

function isResumableAgent(agent: string | undefined): agent is ResumableTuiAgent {
  return RESUMABLE_TUI_AGENTS.some((candidate) => candidate === agent)
}

function providerSession(session: AgentProviderSessionMetadata): RecoveryProviderSession {
  return {
    key: session.key,
    id: session.id,
    ...(session.transcriptPath !== undefined ? { transcriptPath: session.transcriptPath } : {})
  }
}

function accountHomeVariable(
  envKeys: readonly string[]
): RecoveryAgentBinding['launch']['accountHomeVariable'] {
  return envKeys.includes('CLAUDE_CONFIG_DIR')
    ? 'CLAUDE_CONFIG_DIR'
    : envKeys.includes('CODEX_HOME')
      ? 'CODEX_HOME'
      : undefined
}

function optionalText(key: 'terminalTitle' | 'prompt' | 'lastAssistantMessage', value?: string) {
  return value ? { [key]: value } : {}
}

function liveBinding(row: AgentStatusIpcPayload, now: number): RecoveryAgentBinding | null {
  const pane = parsePaneKey(row.paneKey)
  if (!pane || !row.providerSession || !isResumableAgent(row.agentType)) {
    return null
  }
  return {
    sourcePaneKey: row.paneKey,
    sourceTabId: pane.tabId,
    sourceLeafId: pane.leafId,
    surface: 'terminal',
    agent: row.agentType,
    providerSession: providerSession(row.providerSession),
    liveness: 'live',
    state: row.state,
    launch: {
      ...(row.model ? { launchPreferences: { model: row.model } } : {}),
      sourceAgentArgs: null,
      sourceEnvKeys: []
    },
    ...optionalText('prompt', row.prompt),
    ...optionalText('lastAssistantMessage', row.lastAssistantMessage),
    capturedAt: now,
    updatedAt: row.receivedAt,
    lastHumanInputAt: null
  }
}

function sleepingBinding(record: SleepingAgentSessionRecord): RecoveryAgentBinding {
  const pane = parsePaneKey(record.paneKey)
  const sourceEnvKeys = Object.keys(record.launchConfig?.agentEnv ?? {}).sort()
  const accountHome = accountHomeVariable(sourceEnvKeys)
  return {
    sourcePaneKey: record.paneKey,
    sourceTabId: record.tabId ?? pane?.tabId ?? record.paneKey,
    sourceLeafId: pane?.leafId ?? null,
    surface: 'terminal',
    agent: record.agent,
    providerSession: providerSession(record.providerSession),
    liveness: 'sleeping',
    state: record.state,
    launch: {
      sourceAgentArgs: record.launchConfig?.agentArgs ?? null,
      sourceEnvKeys,
      ...(accountHome ? { accountHomeVariable: accountHome } : {})
    },
    ...optionalText('terminalTitle', record.terminalTitle),
    ...optionalText('prompt', record.prompt),
    ...optionalText('lastAssistantMessage', record.lastAssistantMessage),
    capturedAt: record.capturedAt,
    updatedAt: record.updatedAt,
    lastHumanInputAt: null
  }
}

function structuredBinding(
  { record, tabId }: StructuredRecoveryRecord,
  liveRows: ReadonlyMap<string, AgentStatusIpcPayload>,
  now: number
): RecoveryAgentBinding | null {
  const handle = record.providerHandleChain.at(-1)?.handle
  if (!handle || handle.provider !== 'claude') {
    return null
  }
  const live = liveRows.get(handle.sessionId)
  const launchPreferences: RecoveryLaunchPreferences = Object.fromEntries(
    LAUNCH_PREFERENCE_KEYS.flatMap((key) =>
      record.options?.[key] ? [[key, record.options[key]]] : []
    )
  )
  return {
    sourcePaneKey: tabId,
    sourceTabId: tabId,
    sourceLeafId: null,
    surface: 'structured',
    agent: 'claude',
    providerSession: { key: 'session_id', id: handle.sessionId },
    structuredCursor: {
      provider: 'claude',
      sessionId: handle.sessionId,
      leafUuid: handle.leafUuid
    },
    liveness: live ? 'live' : 'sleeping',
    state: live?.state ?? 'done',
    launch: {
      ...(Object.keys(launchPreferences).length > 0 ? { launchPreferences } : {}),
      sourceAgentArgs: null,
      sourceEnvKeys: [],
      accountHomeVariable: record.accountHome.variable
    },
    ...optionalText('prompt', live?.prompt),
    ...optionalText('lastAssistantMessage', live?.lastAssistantMessage),
    capturedAt: now,
    updatedAt: Math.max(record.updatedAt, live?.receivedAt ?? 0),
    lastHumanInputAt: null
  }
}

function prefers(candidate: RecoveryAgentBinding, current: RecoveryAgentBinding): boolean {
  const rank = LIVENESS_RANK[candidate.liveness] - LIVENESS_RANK[current.liveness]
  return rank !== 0 ? rank > 0 : candidate.updatedAt > current.updatedAt
}

/** Live, dormant and structured bindings for one worktree, one per provider session; live wins. */
export function collectRecoveryBindings(sources: RecoveryBindingSources): RecoveryAgentBinding[] {
  const localRows = sources.liveStatuses.filter(
    (row) => row.worktreeId === sources.worktreeId && row.connectionId === null
  )
  const structuredLiveRows = new Map(
    localRows.flatMap((row) =>
      row.structuredHost && row.providerSession ? [[row.providerSession.id, row]] : []
    )
  )
  const candidates = [
    ...localRows.filter((row) => !row.structuredHost).map((row) => liveBinding(row, sources.now)),
    ...sources.sleepingRecords
      .filter((record) => record.worktreeId === sources.worktreeId && !record.connectionId)
      .map(sleepingBinding),
    ...sources.structuredRecords.map((record) =>
      structuredBinding(record, structuredLiveRows, sources.now)
    )
  ]
  const byProviderSession = new Map<string, RecoveryAgentBinding>()
  for (const binding of candidates) {
    if (!binding) {
      continue
    }
    const current = byProviderSession.get(binding.providerSession.id)
    if (!current || prefers(binding, current)) {
      byProviderSession.set(binding.providerSession.id, binding)
    }
  }
  return [...byProviderSession.values()]
}
