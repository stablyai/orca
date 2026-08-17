import {
  linearError,
  sanitizeLinearErrorMessage,
  type LinearAgentAccessError
} from '../linear/issue-context-errors'
import { linearSha256Hex, normalizeLinearLineEndings } from '../linear/linear-text-digest'
import type { LinearProjectUpdateAddIntent } from './linear-project-update-write-intent'

// Why: excludes space, quote, backtick, $, ; and | so no interpolated id can break out of the retry command.
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._:@%+=,/-]+$/

function commandToken(value: string, placeholder: string): string {
  return SAFE_COMMAND_TOKEN.test(value) ? value : placeholder
}

/** Resolved UUIDs only — a name or URL target must never reach a retry command. */
export type LinearProjectWriteRecoveryTarget = {
  projectId: string
  workspaceId: string
}

/**
 * PR3 (`project create`) and PR4 (`project edit`, which has no write id and points
 * at `orca linear project show` instead) add their own members to this union.
 */
export type LinearProjectWriteRecovery = {
  kind: 'update-add'
  target: LinearProjectWriteRecoveryTarget
  writeId: string
  intent: LinearProjectUpdateAddIntent
  cause?: string
}

/** Builds the `linear_write_unconfirmed` error for a project write Orca could not confirm. */
export function linearProjectWriteUnconfirmed(
  recovery: LinearProjectWriteRecovery
): LinearAgentAccessError {
  switch (recovery.kind) {
    case 'update-add':
      return updatePostUnconfirmed(recovery)
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
