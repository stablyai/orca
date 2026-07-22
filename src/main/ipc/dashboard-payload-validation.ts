import type { DashboardRevealAgentArgs, DashboardSnapshot } from '../../shared/dashboard-snapshot'
import {
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_TYPE_MAX_LENGTH
} from '../../shared/agent-status-types'

const MAX_DASHBOARD_CARDS = 1_000
const MAX_ID_LENGTH = 4_096
const MAX_LABEL_LENGTH = 1_024
const DASHBOARD_BUCKETS = new Set(['attention', 'working', 'idle'])
const DASHBOARD_DOT_STATES = new Set(['working', 'blocked', 'waiting', 'done', 'idle'])

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength, true)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isDashboardRevealAgentArgs(value: unknown): value is DashboardRevealAgentArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const args = value as Record<string, unknown>
  return (
    isBoundedString(args.repoId, MAX_ID_LENGTH) &&
    isBoundedString(args.worktreeId, MAX_ID_LENGTH) &&
    isBoundedString(args.tabId, MAX_ID_LENGTH) &&
    (args.leafId === null || isBoundedString(args.leafId, MAX_ID_LENGTH))
  )
}

export function isDashboardPaneKey(value: unknown): value is string {
  return isBoundedString(value, MAX_ID_LENGTH)
}

export function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  return (
    isFiniteNumber(snapshot.generatedAt) &&
    Array.isArray(snapshot.cards) &&
    snapshot.cards.length <= MAX_DASHBOARD_CARDS &&
    snapshot.cards.every(isDashboardCard)
  )
}

function isDashboardCard(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const card = value as Record<string, unknown>
  return (
    isBoundedString(card.paneKey, MAX_ID_LENGTH) &&
    (card.ptyId === null || isBoundedString(card.ptyId, MAX_ID_LENGTH)) &&
    isBoundedString(card.agentType, AGENT_TYPE_MAX_LENGTH) &&
    typeof card.bucket === 'string' &&
    DASHBOARD_BUCKETS.has(card.bucket) &&
    typeof card.dotState === 'string' &&
    DASHBOARD_DOT_STATES.has(card.dotState) &&
    isBoundedString(card.task, AGENT_STATUS_MAX_FIELD_LENGTH, true) &&
    isOptionalBoundedString(card.lastUserMessage, AGENT_STATUS_MAX_FIELD_LENGTH) &&
    isOptionalBoundedString(card.lastAgentMessage, AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH) &&
    isBoundedString(card.repoId, MAX_ID_LENGTH) &&
    isBoundedString(card.worktreeId, MAX_ID_LENGTH) &&
    isBoundedString(card.tabId, MAX_ID_LENGTH) &&
    (card.leafId === null || isBoundedString(card.leafId, MAX_ID_LENGTH)) &&
    isBoundedString(card.repoName, MAX_LABEL_LENGTH, true) &&
    isBoundedString(card.worktreeName, MAX_LABEL_LENGTH, true) &&
    isFiniteNumber(card.startedAt) &&
    (card.finishedAt === null || isFiniteNumber(card.finishedAt)) &&
    isFiniteNumber(card.stateChangedAt) &&
    typeof card.unseen === 'boolean' &&
    isOptionalBoundedString(card.askSummary, AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
  )
}
