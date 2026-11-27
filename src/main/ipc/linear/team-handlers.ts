import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  listTeams,
  getTeamStates,
  getTeamLabels,
  getTeamMembers
} from '../../linear/teams/linear-team-queries'
import { normalizeWorkspaceId, normalizeWorkspaceSelection } from './ipc-args'
import type { LinearWorkspaceSelection } from '../../../shared/linear/workspace-types'

export function registerLinearTeamHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle(
    'linear:listTeams',
    async (_event, args?: { workspaceId?: LinearWorkspaceSelection }) => {
      return listTeams(normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  ipc.handle(
    'linear:teamStates',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamStates(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipc.handle(
    'linear:teamLabels',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamLabels(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipc.handle(
    'linear:teamMembers',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamMembers(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )
}
