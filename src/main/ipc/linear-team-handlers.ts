import { ipcMain } from 'electron'
import { listTeams, getTeamStates, getTeamLabels, getTeamMembers } from '../linear/teams'
import { normalizeWorkspaceId, normalizeWorkspaceSelection } from './linear-ipc-args'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

export function registerLinearTeamHandlers(): void {
  ipcMain.handle(
    'linear:listTeams',
    async (_event, args?: { workspaceId?: LinearWorkspaceSelection }) => {
      return listTeams(normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:teamStates',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamStates(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:teamLabels',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamLabels(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:teamMembers',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamMembers(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )
}
