import {
  linearError,
  sanitizeLinearErrorMessage,
  type LinearAgentAccessError
} from '../linear/issue-context-errors'
import { linearSha256Hex, normalizeLinearLineEndings } from '../linear/linear-text-digest'
import type { LinearProjectCreateIntent } from './linear-project-create-intent'
import type { LinearProjectUpdateAddIntent } from './linear-project-update-write-intent'

// Why: excludes space, quote, backtick, $, ; and | so no interpolated id can break out of the retry command.
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._:@%+=,/-]+$/

const PRIORITY_FLAG_VALUES = ['none', 'urgent', 'high', 'medium', 'low']

function commandToken(value: string, placeholder: string): string {
  return SAFE_COMMAND_TOKEN.test(value) ? value : placeholder
}

/** Resolved UUIDs only — a name or URL target must never reach a retry command. */
export type LinearProjectWriteRecoveryTarget = {
  projectId: string
  workspaceId: string
}

/**
 * PR4 (`project edit`, which has no write id and points at `orca linear project
 * show` instead) adds its own member to this union.
 */
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

/** Builds the `linear_write_unconfirmed` error for a project write Orca could not confirm. */
export function linearProjectWriteUnconfirmed(
  recovery: LinearProjectWriteRecovery
): LinearAgentAccessError {
  switch (recovery.kind) {
    case 'update-add':
      return updatePostUnconfirmed(recovery)
    case 'create':
      return createUnconfirmed(recovery)
  }
}

function updatePostUnconfirmed(
  recovery: Extract<LinearProjectWriteRecovery, { kind: 'update-add' }>
): LinearAgentAccessError {
  const { target, writeId, intent } = recovery
  // Why: one platform-neutral line; the body travels on stdin so it never reaches a shell.
  const pinned = [
    'orca linear project update add',
    commandToken(target.projectId, 'PROJECT_ID'),
    '--body-file -',
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
      ...textDigestFields('icon', intent.icon),
      nextSteps: [
        `Retry once with the pinned command, replacing every UPPERCASE placeholder with the exact original text and supplying the same content on stdin: \`${pinned}\`.`
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
    '--name NAME',
    ...intent.teamIds.map((id) => `--team=${commandToken(id, 'TEAM_ID')}`),
    ...(intent.description !== undefined ? ['--description DESCRIPTION'] : []),
    ...(intent.content !== undefined ? ['--content-file -'] : []),
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
    // Why: a #RRGGBB literal starts a shell comment, so it is always a placeholder.
    ...(intent.color ? ['--color COLOR'] : []),
    ...(intent.icon !== undefined ? ['--icon ICON'] : []),
    `--write-id=${commandToken(writeId, 'WRITE_ID')}`,
    `--workspace=${commandToken(intent.workspaceId, 'WORKSPACE_ID')}`,
    '--json'
  ].join(' ')
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
