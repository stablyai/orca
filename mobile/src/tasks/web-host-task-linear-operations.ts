import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskLinearOperations, HostTaskLinearTarget } from './host-task-linear-operations'

export function webHostTaskLinearOperations(
  client: MobileWebBridgeClient
): HostTaskLinearOperations {
  return {
    async connect(apiKey) {
      await client.task.connectLinear({ apiKey })
    },
    async listTeams() {
      return (await client.task.listLinearTeams({})).teams
    },
    async teamStates(target) {
      return (await client.task.listLinearTeamStates({ targetId: targetId(target) })).states
    },
    async selectWorkspace(workspaceId) {
      await client.task.selectLinearWorkspace({ workspaceId })
    },
    async updateState(target, stateId) {
      await client.task.updateLinearIssueState({ targetId: targetId(target), stateId })
    },
    async addComment(target, body) {
      return (await client.task.addLinearIssueComment({ targetId: targetId(target), body })).id
    },
    async loadIssue(target) {
      return (await client.task.loadLinearIssue({ targetId: targetId(target) })).issue
    },
    async createSubIssue(target, title) {
      return (await client.task.createLinearSubIssue({ targetId: targetId(target), title })).issue
    },
    async createIssue(payload) {
      return (
        await client.task.createLinearIssue({
          teamId: payload.team.id,
          ...(payload.team.workspaceId ? { workspaceId: payload.team.workspaceId } : {}),
          title: payload.title,
          ...(payload.description ? { description: payload.description } : {})
        })
      ).issue
    }
  }
}

function targetId(target: HostTaskLinearTarget): string {
  if (!target.targetId) {
    throw new Error('Linear task authority is unavailable')
  }
  return target.targetId
}
