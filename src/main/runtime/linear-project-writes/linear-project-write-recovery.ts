import {
  linearError,
  sanitizeLinearErrorMessage,
  type LinearAgentAccessError
} from '../../linear/issue-context-errors'
import { linearSha256Hex, normalizeLinearLineEndings } from '../../linear/linear-text-digest'
import type { LinearProjectCreateIntent } from './linear-project-create-intent'
import type { LinearProjectEditIntent } from './linear-project-edit-intent'
import type { LinearProjectUpdateAddIntent } from './linear-project-update-write-intent'

// Why: excludes space, quote, backtick, $, ; and | so no interpolated id can break out of the retry command.
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._:@%+=,/-]+$/

const PRIORITY_FLAG_VALUES = ['none', 'urgent', 'high', 'medium', 'low']
// Why: dedup compares health and isDiffHidden, so a retry that drops them either
// trips linear_invalid_write_id or silently re-posts with the diff shown.
const HEALTH_FLAG_VALUES: Record<string, string> = {
  onTrack: 'on-track',
  atRisk: 'at-risk',
  offTrack: 'off-track'
}

function commandToken(value: string, placeholder: string): string {
  return SAFE_COMMAND_TOKEN.test(value) ? value : placeholder
}

/** Resolved UUIDs only — a name or URL target must never reach a retry command. */
export type LinearProjectWriteRecoveryTarget = {
  projectId: string
  workspaceId: string
}

/** `edit` carries no write id: `ProjectUpdateInput` has none, so no retry can be pinned. */
export type LinearProjectWriteRecovery =
  | {
      kind: 'update-add'
      target: LinearProjectWriteRecoveryTarget
      writeId: string
      intent: LinearProjectUpdateAddIntent
      cause?: string
    }
  | {
      kind: 'create'
      writeId: string
      intent: LinearProjectCreateIntent
      cause?: string
    }
  | {
      kind: 'edit'
      target: LinearProjectWriteRecoveryTarget
      intent: LinearProjectEditIntent
      cause?: string
    }

/** Builds the `linear_write_unconfirmed` error for a project write Orca could not confirm. */
export function linearProjectWriteUnconfirmed(
  recovery: LinearProjectWriteRecovery
): LinearAgentAccessError {
  switch (recovery.kind) {
    case 'update-add':
      return updatePostUnconfirmed(recovery)
    case 'create':
      return createUnconfirmed(recovery)
    case 'edit':
      return editUnconfirmed(recovery)
  }
}

/**
 * A field edit has no write id, so recovery is a read: `project show` is the only
 * safe way to learn what the project holds now before anything is retried.
 */
function editUnconfirmed(
  recovery: Extract<LinearProjectWriteRecovery, { kind: 'edit' }>
): LinearAgentAccessError {
  const { target, intent } = recovery
  const show = [
    'orca linear project show',
    commandToken(target.projectId, 'PROJECT_ID'),
    '--workspace',
    commandToken(target.workspaceId, 'WORKSPACE_ID'),
    '--json'
  ].join(' ')
  const { edits } = intent
  return linearError(
    'linear_write_unconfirmed',
    'Linear may have applied the project edit, but Orca could not confirm it.',
    {
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      requestedFields: intent.requested,
      statusId: edits.statusId ?? null,
      leadId: edits.leadId ?? null,
      memberIds: edits.memberIds ?? null,
      teamIds: edits.teamIds ?? null,
      labelIds: edits.labelIds ?? null,
      priority: edits.priority ?? null,
      startDate: edits.startDate ?? null,
      targetDate: edits.targetDate ?? null,
      color: edits.color ?? null,
      ...textDigestFields('name', edits.name),
      ...textDigestFields('description', edits.description),
      ...textDigestFields('content', edits.content ?? undefined),
      nextSteps: [
        `Run \`${show}\` and compare the current fields against the requested counts and digests before retrying.`,
        'Do not retry a member, team, or label replacement until that read confirms the full current collection; another actor may have edited it.'
      ],
      ...(recovery.cause ? { cause: sanitizeLinearErrorMessage(recovery.cause) } : {})
    }
  )
}

function updatePostUnconfirmed(
  recovery: Extract<LinearProjectWriteRecovery, { kind: 'update-add' }>
): LinearAgentAccessError {
  const { target, writeId, intent } = recovery
  // Why: one platform-neutral line; the body travels on stdin so it never reaches a shell.
  const pinned = [
    'orca linear project update add',
    commandToken(target.projectId, 'PROJECT_ID'),
    // Why: a blank-but-legal body is rejected by the stdin readers, so it has to travel
    // inline — and verbatim, because dedup compares the body exactly. A newline cannot
    // travel that way without splitting this line, so it stays on the unrunnable stdin
    // form rather than silently retrying under a body that would fail the write-id check.
    blankInlineBody(intent.body) ?? '--body-file -',
    ...(intent.health ? [`--health=${HEALTH_FLAG_VALUES[intent.health] ?? 'HEALTH'}`] : []),
    ...(intent.isDiffHidden ? ['--hide-diff'] : []),
    `--write-id=${commandToken(writeId, 'WRITE_ID')}`,
    `--workspace=${commandToken(target.workspaceId, 'WORKSPACE_ID')}`,
    '--json'
  ].join(' ')
  const body = normalizeLinearLineEndings(intent.body)
  return linearError(
    'linear_write_unconfirmed',
    'Linear may have posted the project update, but Orca could not confirm it.',
    {
      writeId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      health: intent.health ?? null,
      isDiffHidden: intent.isDiffHidden,
      bodyChars: body.length,
      bodySha256: linearSha256Hex(body),
      nextSteps: [
        `Retry once with the pinned command, piping the exact same body on stdin: \`${pinned}\`.`
      ],
      ...(recovery.cause ? { cause: sanitizeLinearErrorMessage(recovery.cause) } : {})
    }
  )
}

function createUnconfirmed(
  recovery: Extract<LinearProjectWriteRecovery, { kind: 'create' }>
): LinearAgentAccessError {
  const { writeId, intent } = recovery
  const pinned = createRetryCommand(writeId, intent)
  return linearError(
    'linear_write_unconfirmed',
    'Linear may have created the project, but Orca could not confirm it.',
    {
      writeId,
      workspaceId: intent.workspaceId,
      teamIds: intent.teamIds,
      statusId: intent.statusId ?? null,
      leadId: intent.leadId ?? null,
      memberIds: intent.memberIds ?? null,
      labelIds: intent.labelIds ?? null,
      priority: intent.priority ?? null,
      startDate: intent.startDate ?? null,
      targetDate: intent.targetDate ?? null,
      color: intent.color ?? null,
      ...textDigestFields('name', intent.name),
      ...textDigestFields('description', intent.description),
      ...textDigestFields('content', intent.content),
      nextSteps: [
        `Retry once with the pinned command, replacing every UPPERCASE placeholder with the exact original text, escaped for your shell${pinned.includes('--content-file -') ? ', and supplying the same content on stdin' : ''}: \`${pinned}\`.`
      ],
      ...(recovery.cause ? { cause: sanitizeLinearErrorMessage(recovery.cause) } : {})
    }
  )
}

/**
 * One platform-neutral line. References travel as resolved ids; the name and all
 * prose travel as placeholders so user-controlled text never reaches a shell.
 */
function createRetryCommand(writeId: string, intent: LinearProjectCreateIntent): string {
  return [
    'orca linear project create',
    // Why: the agent substitutes the real text here, and an unquoted `Payments V2`
    // would split into a stray positional the create spec rejects outright.
    '--name="NAME"',
    ...intent.teamIds.map((id) => `--team=${commandToken(id, 'TEAM_ID')}`),
    ...(intent.description !== undefined ? ['--description="DESCRIPTION"'] : []),
    // Why: the stdin readers reject whitespace-only input too, so a blank body has to
    // travel inline. It travels as `--content=` rather than the literal text because
    // Linear stores every blank spelling as '' anyway, and a newline in the value
    // would split this command across two lines.
    ...(intent.content !== undefined
      ? [intent.content.trim() === '' ? '--content=' : '--content-file -']
      : []),
    ...(intent.statusId ? [`--status=${commandToken(intent.statusId, 'STATUS_ID')}`] : []),
    ...(intent.leadId ? [`--lead=${commandToken(intent.leadId, 'LEAD_ID')}`] : []),
    ...(intent.memberIds ?? []).map((id) => `--member=${commandToken(id, 'MEMBER_ID')}`),
    ...(intent.labelIds ?? []).map((id) => `--label=${commandToken(id, 'LABEL_ID')}`),
    ...(intent.priority !== undefined
      ? [`--priority=${PRIORITY_FLAG_VALUES[intent.priority] ?? 'PRIORITY'}`]
      : []),
    ...(intent.startDate ? [`--start-date=${commandToken(intent.startDate, 'START_DATE')}`] : []),
    ...(intent.targetDate
      ? [`--target-date=${commandToken(intent.targetDate, 'TARGET_DATE')}`]
      : []),
    // Why: `--color #RRGGBB` would comment out the rest of the line on POSIX shells
    // and take --write-id with it; `#` mid-word after `=` is literal in every shell.
    ...(intent.color ? [`--color=${commandToken(intent.color, 'COLOR')}`] : []),
    `--write-id=${commandToken(writeId, 'WRITE_ID')}`,
    `--workspace=${commandToken(intent.workspaceId, 'WORKSPACE_ID')}`,
    '--json'
  ].join(' ')
}

/** A whitespace-only body that still fits on one line, as a verbatim inline flag. */
function blankInlineBody(body: string): string | null {
  const isBlank = body.trim() === ''
  return isBlank && !/[\r\n]/.test(body) ? `--body="${body}"` : null
}

function textDigestFields(
  field: string,
  value: string | undefined
): Record<string, number | string | null> {
  if (value === undefined) {
    return { [`${field}Chars`]: null, [`${field}Sha256`]: null }
  }
  const normalized = normalizeLinearLineEndings(value)
  return {
    [`${field}Chars`]: normalized.length,
    [`${field}Sha256`]: linearSha256Hex(normalized)
  }
}
