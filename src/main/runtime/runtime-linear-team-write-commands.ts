import {
  resolve,
  isPathInsideOrEqual,
  getLinearStatus,
  LinearAgentAccessError,
  getLinearCurrentIssueFromWorktree,
  resolveLegacyLinearLinkWorkspace,
  linearError,
  listLinearTeamsOrThrow
} from './runtime-linear-command-dependencies'
import type {
  LinearCurrentIssueContextHints,
  LinearErrorCode,
  LinearAgentWriteTarget
} from './runtime-linear-command-dependencies'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { RuntimeLinearDedupeCommands } from './runtime-linear-dedupe-commands'

export class RuntimeLinearTeamWriteCommands extends RuntimeLinearDedupeCommands {
  public parseLinearAttachmentUrl(value: string): URL {
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url
      }
    } catch {
      // Fall through to the stable agent-facing error below.
    }
    throw linearError('linear_invalid_url', 'Attachment URL must be an absolute http(s) URL.')
  }

  public defaultLinearAttachmentTitle(url: URL): string {
    const tail = url.pathname.split('/').findLast(Boolean)
    return tail ? `${url.host}/${tail}` : url.host
  }

  public linearWorkspaceErrorCode(type: string): LinearErrorCode {
    if (type === 'auth') {
      return 'linear_auth_expired'
    }
    if (type === 'network') {
      return 'linear_network_error'
    }
    if (type === 'rate_limited') {
      return 'linear_rate_limited'
    }
    return 'linear_write_failed'
  }

  public linearTeamSummary(team: {
    id: string
    name: string
    key: string
    url?: string
    workspaceId?: string
    workspaceName?: string
  }): {
    id: string
    name: string
    key: string
    url?: string
    workspace?: { id: string; name: string }
  } {
    return {
      id: team.id,
      name: team.name,
      key: team.key,
      ...(team.url ? { url: team.url } : {}),
      ...(team.workspaceId
        ? { workspace: { id: team.workspaceId, name: team.workspaceName ?? team.workspaceId } }
        : {})
    }
  }

  public async resolveLinearTeamInput(
    teamInput: string,
    workspaceId?: (string & {}) | 'all'
  ): Promise<{
    id: string
    key: string
    name: string
    workspaceId: string
    workspaceName?: string
  }> {
    this.validateLinearCreateWorkspaceScope(workspaceId === 'all' ? undefined : workspaceId)
    let teams: Awaited<ReturnType<typeof listLinearTeamsOrThrow>>
    try {
      teams = await listLinearTeamsOrThrow(workspaceId ?? 'all')
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
    const normalized = teamInput.toLocaleLowerCase()
    const idMatches = teams.filter((team) => team.id.toLocaleLowerCase() === normalized)
    const matches =
      idMatches.length > 0
        ? idMatches
        : teams.filter((team) => team.key.toLocaleLowerCase() === normalized)
    if (matches.length === 1 && matches[0].workspaceId) {
      return {
        id: matches[0].id,
        key: matches[0].key,
        name: matches[0].name,
        workspaceId: matches[0].workspaceId,
        workspaceName: matches[0].workspaceName
      }
    }
    if (matches.length > 1) {
      throw linearError(
        'linear_workspace_ambiguous',
        `Team ${teamInput} exists in multiple workspaces.`,
        {
          candidates: matches.map((team) => ({
            workspaceId: team.workspaceId,
            workspaceName: team.workspaceName,
            teamId: team.id,
            teamKey: team.key
          }))
        }
      )
    }
    throw linearError('linear_team_required', `No connected Linear team matched ${teamInput}.`)
  }

  public async resolveLinearCreateTeam(
    teamInput: string | undefined,
    workspaceId: string | undefined,
    parent: LinearAgentWriteTarget | null
  ): Promise<{ id: string; key: string; name: string; workspaceId: string }> {
    if (!teamInput && parent?.issue.team?.id && parent.issue.team.key && parent.issue.team.name) {
      return {
        id: parent.issue.team.id,
        key: parent.issue.team.key,
        name: parent.issue.team.name,
        workspaceId: parent.workspaceId
      }
    }
    if (!teamInput) {
      throw linearError('linear_team_required', 'Pass --team or create under a parent issue.', {
        nextSteps: ['Run `orca linear create --team <key> ...` or use --parent-current.']
      })
    }

    const scope = parent?.workspaceId ?? workspaceId
    this.validateLinearCreateWorkspaceScope(scope)
    let teams: Awaited<ReturnType<typeof listLinearTeamsOrThrow>>
    try {
      teams = await listLinearTeamsOrThrow(scope ?? 'all')
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
    if (teams.length === 0 && (getLinearStatus().workspaces?.length ?? 0) === 0) {
      throw linearError('linear_not_connected', 'Linear is not connected.', {
        nextSteps: ['Connect Linear from Orca settings, then retry the issue create.']
      })
    }
    const matches = teams.filter(
      (team) =>
        team.id.toLocaleLowerCase() === teamInput.toLocaleLowerCase() ||
        team.key.toLocaleLowerCase() === teamInput.toLocaleLowerCase()
    )
    if (matches.length === 1 && matches[0].workspaceId) {
      return {
        id: matches[0].id,
        key: matches[0].key,
        name: matches[0].name,
        workspaceId: matches[0].workspaceId
      }
    }
    if (matches.length > 1) {
      throw linearError(
        'linear_workspace_ambiguous',
        `Team ${teamInput} exists in multiple workspaces.`,
        {
          candidates: matches.map((team) => ({
            workspaceId: team.workspaceId,
            workspaceName: team.workspaceName,
            teamKey: team.key
          }))
        }
      )
    }
    if (parent) {
      let globalTeams: Awaited<ReturnType<typeof listLinearTeamsOrThrow>>
      try {
        globalTeams = await listLinearTeamsOrThrow('all')
      } catch (error) {
        throw this.mapLinearReadFailure(error)
      }
      const globalMatch = globalTeams.find(
        (team) =>
          team.id.toLocaleLowerCase() === teamInput.toLocaleLowerCase() ||
          team.key.toLocaleLowerCase() === teamInput.toLocaleLowerCase()
      )
      if (globalMatch) {
        throw linearError(
          'linear_invalid_workspace',
          `Team ${teamInput} is not in the parent issue workspace.`
        )
      }
    }
    throw linearError('linear_team_required', `No connected Linear team matched ${teamInput}.`)
  }

  public validateLinearCreateWorkspaceScope(workspaceId: string | undefined): void {
    if (!workspaceId) {
      return
    }
    const workspaces = getLinearStatus().workspaces ?? []
    if (workspaces.length > 0 && !workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw linearError(
        'linear_invalid_workspace',
        `No connected Linear workspace matched ${workspaceId}.`
      )
    }
  }
  async linearResolveCurrentIssue(
    context?: LinearCurrentIssueContextHints
  ): Promise<ReturnType<typeof getLinearCurrentIssueFromWorktree>> {
    if (!this.runtimeAvailable()) {
      throw new Error('runtime_unavailable')
    }

    let worktree: ResolvedWorktree | null = null
    if (context?.terminalHandle) {
      try {
        const terminal = await this.showTerminal(context.terminalHandle)
        if (context.worktreeId && context.worktreeId !== terminal.worktreeId) {
          throw new LinearAgentAccessError(
            'linear_permission_denied',
            'The provided Linear worktree context does not match the caller terminal.'
          )
        }
        worktree = await this.resolveWorktreeSelector(`id:${terminal.worktreeId}`)
      } catch (error) {
        if (error instanceof LinearAgentAccessError) {
          throw error
        }
        if (context.remote === true || context.worktreeId) {
          throw new LinearAgentAccessError(
            'linear_issue_required',
            'Could not verify the current Linear-linked worktree.'
          )
        }
      }
    }

    if (!worktree && context?.remote !== true && context?.cwd) {
      worktree = await this.resolveWorktreeForContainedPath(context.cwd)
      if (!worktree) {
        throw new LinearAgentAccessError(
          'linear_issue_required',
          'Run --current from inside an Orca-managed worktree or pass an issue id.'
        )
      }
    }

    if (!worktree) {
      throw new LinearAgentAccessError(
        'linear_issue_required',
        'Run --current from inside an Orca-managed worktree or pass an issue id.'
      )
    }

    const link = getLinearCurrentIssueFromWorktree(worktree)
    if (!link.workspaceId) {
      const backfill = resolveLegacyLinearLinkWorkspace(
        worktree.linkedLinearIssue ?? '',
        worktree.linkedLinearIssueOrganizationUrlKey
      )
      if (backfill?.workspaceId) {
        this.setWorktreeMeta(worktree.id, {
          linkedLinearIssueWorkspaceId: backfill.workspaceId,
          linkedLinearIssueOrganizationUrlKey: backfill.organizationUrlKey ?? null
        })
        return {
          ...link,
          workspaceId: backfill.workspaceId,
          organizationUrlKey: backfill.organizationUrlKey ?? link.organizationUrlKey,
          backfill
        }
      }
    }
    return link
  }
  public async resolveWorktreeForContainedPath(cwd: string): Promise<ResolvedWorktree | null> {
    const currentPath = resolve(cwd)
    let best: ResolvedWorktree | null = null
    for (const candidate of await this.listResolvedWorktrees()) {
      if (!isPathInsideOrEqual(candidate.path, currentPath)) {
        continue
      }
      if (!best || candidate.path.length > best.path.length) {
        best = candidate
      }
    }
    return best
  }
}
