import {
  type LinearAgentAccessError,
  type LinearAgentWriteTarget,
  type LinearCreateFieldIntent,
  linearError,
  sanitizeLinearErrorMessage
} from './runtime-linear-command-dependencies'
import { RuntimeLinearCommandBase } from './runtime-linear-command-base'

export class RuntimeLinearRetryCommands extends RuntimeLinearCommandBase {
  public linearCreateStyleUnconfirmed(
    verb: 'comment' | 'attach' | 'create',
    writeId: string,
    target: LinearAgentWriteTarget | null,
    extra: {
      parentId?: string | null
      team?: { id: string; key: string; name: string; workspaceId: string }
      parent?: LinearAgentWriteTarget | null
      title?: string
      url?: string
      bodyRequired?: boolean
      createFields?: LinearCreateFieldIntent
      cause?: string
    } = {}
  ): LinearAgentAccessError {
    const workspaceId = target?.workspaceId ?? extra.team?.workspaceId ?? ''
    // Why: the retry preserves id and target so duplicate recovery can prove intent without matching mutable content.
    const pinned =
      verb === 'create'
        ? [
            'orca linear create',
            `--workspace=${this.commandToken(workspaceId, 'WORKSPACE_ID')}`,
            `--write-id=${this.commandToken(writeId, 'WRITE_ID')}`,
            '--title TITLE_HERE',
            ...(extra.bodyRequired ? ['--body-file -'] : []),
            ...(extra.parent
              ? [`--parent=${this.commandToken(extra.parent.issue.identifier, 'PARENT_ISSUE')}`]
              : []),
            ...(extra.team
              ? [`--team=${this.commandToken(extra.team.key, 'TEAM_KEY')}`]
              : []
            ).concat(this.linearCreateFieldRetryTokens(extra.createFields))
          ].join(' ')
        : [
            `orca linear ${verb === 'attach' ? 'attach' : 'comment add'}`,
            this.commandToken(target?.issue.identifier ?? '', 'ISSUE_ID'),
            `--workspace=${this.commandToken(workspaceId, 'WORKSPACE_ID')}`,
            `--write-id=${this.commandToken(writeId, 'WRITE_ID')}`,
            ...(verb === 'comment' ? ['--body-file -'] : []),
            ...(verb === 'comment' && extra.parentId
              ? [`--reply-to=${this.commandToken(extra.parentId, 'COMMENT_ID')}`]
              : []),
            ...(verb === 'attach' ? ['--url URL_HERE', '--title TITLE_HERE'] : [])
          ].join(' ')
    const retryPrefix = extra.bodyRequired || verb === 'comment' ? 'Pipe the same body and r' : 'R'
    const payloadNote =
      verb === 'attach'
        ? ' Replace TITLE_HERE/URL_HERE with the exact original payload values before running.'
        : verb === 'create'
          ? ' Replace TITLE_HERE with the exact original title before running.'
          : ''
    return linearError(
      'linear_write_unconfirmed',
      'Linear may have applied the write, but Orca could not confirm it.',
      {
        writeId,
        workspaceId,
        issueIdentifier: target?.issue.identifier,
        parentId: extra.parentId,
        team: extra.team ? { id: extra.team.id, key: extra.team.key } : undefined,
        parentIdentifier: extra.parent?.issue.identifier,
        createFields: extra.createFields,
        nextSteps: [
          `${retryPrefix}etry once with the pinned command: \`${pinned}\`.${payloadNote}`
        ],
        ...(extra.cause ? { cause: sanitizeLinearErrorMessage(extra.cause) } : {})
      }
    )
  }

  public commandToken(value: string, placeholder: string): string {
    return /^[A-Za-z0-9._:@%+=,/-]+$/.test(value) ? value : placeholder
  }

  public async notifyLinearLinkedIssueUpdated(
    workspaceId: string,
    identifier: string | readonly string[]
  ): Promise<void> {
    const identifiers = typeof identifier === 'string' ? [identifier] : identifier
    const normalized = new Map(
      identifiers.map((value) => [value.toLocaleUpperCase(), value] as const)
    )
    for (const worktree of await this.listResolvedWorktrees()) {
      const linkedIdentifier = normalized.get(
        (worktree.linkedLinearIssue ?? '').toLocaleUpperCase()
      )
      if (!linkedIdentifier) {
        continue
      }
      const linkedWorkspaceId = worktree.linkedLinearIssueWorkspaceId ?? workspaceId
      if (linkedWorkspaceId !== workspaceId) {
        continue
      }
      this.emitClientEvent({
        type: 'linearLinkedIssueUpdated',
        worktreeId: worktree.id,
        identifier: linkedIdentifier,
        workspaceId
      })
    }
  }
  public linearCreateFieldRetryTokens(fields: LinearCreateFieldIntent | undefined): string[] {
    if (!fields) {
      return []
    }
    return [
      ...(fields.stateId ? [`--state=${this.commandToken(fields.stateId, 'STATE_ID')}`] : []),
      ...(fields.assigneeId
        ? [`--assignee=${this.commandToken(fields.assigneeId, 'ASSIGNEE_ID')}`]
        : []),
      ...(fields.priority !== undefined
        ? [`--priority=${this.linearPriorityRetryToken(fields.priority)}`]
        : []),
      ...(fields.estimate !== undefined && fields.estimate !== null
        ? [`--estimate=${fields.estimate}`]
        : []),
      ...(fields.dueDate ? [`--due-date=${fields.dueDate}`] : []),
      ...(fields.projectId
        ? [`--project=${this.commandToken(fields.projectId, 'PROJECT_ID')}`]
        : []),
      ...(fields.labelIds ?? []).map(
        (labelId) => `--label=${this.commandToken(labelId, 'LABEL_ID')}`
      )
    ]
  }
  public linearPriorityRetryToken(priority: number): string {
    if (priority === 1) {
      return 'urgent'
    }
    if (priority === 2) {
      return 'high'
    }
    if (priority === 3) {
      return 'medium'
    }
    if (priority === 4) {
      return 'low'
    }
    return 'none'
  }
}
