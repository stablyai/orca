import { registerAppHandler } from '../app-registry/app-handler-registry'

import {
  listTeams,
  getTeamStates,
  getTeamLabels,
  getTeamMembers
} from '../../linear/teams/linear-team-queries'
import { normalizeWorkspaceId, normalizeWorkspaceSelection } from './ipc-args'
import type { LinearWorkspaceSelection } from '../../../shared/linear/workspace-types'

export function registerLinearTeamHandlers(): void {
  registerAppHandler(
    'linear:listTeams',
    async (_event, args?: { workspaceId?: LinearWorkspaceSelection }) => {
      return listTeams(normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  registerAppHandler(
    'linear:teamStates',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamStates(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  registerAppHandler(
    'linear:teamLabels',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamLabels(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  registerAppHandler(
    'linear:teamMembers',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamMembers(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )
}
