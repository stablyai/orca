import type { WorkInboxItem, WorkInboxOption, WorkInboxStatus } from '../../../shared/work-inbox'

// Why additive and unversioned: older builds ignore the table, so no orchestration schema bump is needed.
export const WORK_INBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_inbox_items (
  id                TEXT PRIMARY KEY,
  revision          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'answered', 'delivered', 'cancelled')),
  asker_handle      TEXT NOT NULL,
  asker_pane_key    TEXT,
  project_id        TEXT,
  project_label     TEXT,
  worktree_id       TEXT,
  agent_kind        TEXT,
  question          TEXT NOT NULL,
  options           TEXT NOT NULL DEFAULT '[]',
  allow_free_text   INTEGER NOT NULL DEFAULT 1,
  answer_option_id  TEXT,
  answer_text       TEXT,
  answer_request_id TEXT,
  ask_request_id    TEXT,
  created_at        INTEGER NOT NULL,
  answered_at       INTEGER,
  delivered_at      INTEGER,
  cancelled_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_work_inbox_status_created ON work_inbox_items(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_inbox_ask_request
  ON work_inbox_items(asker_handle, ask_request_id) WHERE ask_request_id IS NOT NULL;
`

export type WorkInboxRow = {
  id: string
  revision: number
  status: WorkInboxStatus
  asker_handle: string
  asker_pane_key: string | null
  project_id: string | null
  project_label: string | null
  worktree_id: string | null
  agent_kind: string | null
  question: string
  options: string
  allow_free_text: number
  answer_option_id: string | null
  answer_text: string | null
  answer_request_id: string | null
  ask_request_id: string | null
  created_at: number
  answered_at: number | null
  delivered_at: number | null
  cancelled_at: number | null
}

export type WorkInboxAsker = {
  handle: string
  paneKey: string | null
  projectId: string | null
  projectLabel: string | null
  worktreeId: string | null
  agentKind: string | null
}

export function parseOptions(raw: string): WorkInboxOption[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isOption) : []
  } catch {
    return []
  }
}

function isOption(value: unknown): value is WorkInboxOption {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'label' in value &&
    typeof value.label === 'string'
  )
}

function agentLabel(row: WorkInboxRow): string {
  return row.agent_kind ? `${row.agent_kind} · ${row.asker_handle}` : row.asker_handle
}

export function toItem(row: WorkInboxRow): WorkInboxItem {
  const options = parseOptions(row.options)
  const answered = row.answer_option_id !== null || row.answer_text !== null
  const optionLabel = options.find((option) => option.id === row.answer_option_id)?.label
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    projectId: row.project_id,
    projectLabel: row.project_label,
    worktreeId: row.worktree_id,
    agentId: row.asker_handle,
    agentLabel: agentLabel(row),
    agentKind: row.agent_kind,
    question: row.question,
    options,
    allowFreeText: row.allow_free_text === 1,
    createdAt: row.created_at,
    ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    ...(row.cancelled_at !== null ? { cancelledAt: row.cancelled_at } : {}),
    ...(answered
      ? {
          answer: {
            ...(row.answer_option_id !== null ? { optionId: row.answer_option_id } : {}),
            ...(optionLabel !== undefined ? { optionLabel } : {}),
            ...(row.answer_text !== null ? { text: row.answer_text } : {})
          }
        }
      : {})
  }
}
