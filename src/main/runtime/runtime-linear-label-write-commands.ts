import {
  type getLinearIssueByUuidForAgent,
  type LinearIssueTaskUpdateRequest,
  type LinearIssueTaskUpdateResult,
  type LinearIssueSummary,
  getLinearTeamLabelsOrThrow,
  linearError,
  sameStringSet
} from './runtime-linear-command-dependencies'
import { RuntimeLinearProjectWriteCommands } from './runtime-linear-project-write-commands'

export class RuntimeLinearLabelWriteCommands extends RuntimeLinearProjectWriteCommands {
  public async resolveLinearLabelsForIssue(
    issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    inputs: string[],
    workspaceId: string
  ): Promise<{ id: string; name: string }[]> {
    const labels = await this.getLinearTeamLabelsForWrite(issue.team.id, workspaceId)
    const resolved = inputs.map((input) => {
      const normalized = input.toLocaleLowerCase()
      const idMatch = labels.find((label) => label.id.toLocaleLowerCase() === normalized)
      if (idMatch) {
        return { id: idMatch.id, name: idMatch.name }
      }
      const nameMatches = labels.filter((label) => label.name.toLocaleLowerCase() === normalized)
      if (nameMatches.length === 1) {
        return { id: nameMatches[0].id, name: nameMatches[0].name }
      }
      throw linearError(
        'linear_invalid_label',
        nameMatches.length === 0
          ? `No label exactly matched "${input}".`
          : `Multiple labels exactly matched "${input}".`,
        {
          labels: labels.map((label) => ({ id: label.id, name: label.name })),
          nextSteps: ['Run `orca linear team labels --team <key-or-id> --json` and retry by id.']
        }
      )
    })
    return Array.from(new Map(resolved.map((label) => [label.id, label])).values())
  }

  public async resolveLinearLabelsForTeam(
    teamId: string,
    inputs: string[],
    workspaceId: string
  ): Promise<{ id: string; name: string }[]> {
    const labels = await this.getLinearTeamLabelsForWrite(teamId, workspaceId)
    const resolved = inputs.map((input) => {
      const normalized = input.toLocaleLowerCase()
      const idMatch = labels.find((label) => label.id.toLocaleLowerCase() === normalized)
      if (idMatch) {
        return { id: idMatch.id, name: idMatch.name }
      }
      const nameMatches = labels.filter((label) => label.name.toLocaleLowerCase() === normalized)
      if (nameMatches.length === 1) {
        return { id: nameMatches[0].id, name: nameMatches[0].name }
      }
      throw linearError(
        'linear_invalid_label',
        nameMatches.length === 0
          ? `No label exactly matched "${input}".`
          : `Multiple labels exactly matched "${input}".`,
        { labels: labels.map((label) => ({ id: label.id, name: label.name })) }
      )
    })
    return Array.from(new Map(resolved.map((label) => [label.id, label])).values())
  }

  public linearTaskFieldAlreadySet(
    operation: LinearIssueTaskUpdateRequest['operation'],
    record: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    update: {
      fields: {
        assigneeId?: string | null
        priority?: number
        estimate?: number | null
        dueDate?: string | null
        labelIds?: string[]
      }
    }
  ): boolean {
    if (operation === 'assignee') {
      return (record.assignee?.id ?? null) === update.fields.assigneeId
    }
    if (operation === 'priority') {
      return record.priority === update.fields.priority
    }
    if (operation === 'estimate') {
      return (record.estimate ?? null) === update.fields.estimate
    }
    if (operation === 'dueDate') {
      return (record.dueDate ?? null) === update.fields.dueDate
    }
    if (operation === 'labels') {
      const recordLabelIds = record.labelIds ?? record.labels?.map((label) => label.id) ?? []
      return sameStringSet(recordLabelIds, update.fields.labelIds ?? [])
    }
    return false
  }

  public linearTaskUpdateResult(
    operation: LinearIssueTaskUpdateRequest['operation'],
    issue: LinearIssueSummary,
    workspaceId: string,
    previous: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    current: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    alreadySet: boolean
  ): LinearIssueTaskUpdateResult {
    return {
      issue: this.linearWriteIssueRef(issue),
      operation,
      previous: this.linearTaskResultFields(previous),
      current: this.linearTaskResultFields(current),
      meta: { workspaceId, alreadySet }
    }
  }

  public linearTaskResultFields(
    record: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>
  ): LinearIssueTaskUpdateResult['current'] {
    return {
      assignee: record.assignee ?? null,
      priority: record.priority ?? null,
      estimate: record.estimate ?? null,
      dueDate: record.dueDate ?? null,
      labels: record.labels ?? []
    }
  }
  public async getLinearTeamLabelsForWrite(
    teamId: string,
    workspaceId: string
  ): Promise<Awaited<ReturnType<typeof getLinearTeamLabelsOrThrow>>> {
    try {
      return await getLinearTeamLabelsOrThrow(teamId, workspaceId)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
}
