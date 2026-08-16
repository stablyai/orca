import { ipcMain } from 'electron'
import type { AgentContextInspectTarget, AgentContextReport } from '../../shared/agent-context'
import { SkillDiscoveryTargetSchema } from '../../shared/skills'
import { inspectAgentContextOnTarget } from '../agent-context/agent-context-target'
import { resolveSkillDiscoveryTarget } from '../skills/skill-discovery-target'

export function registerAgentContextHandlers(): void {
  ipcMain.handle(
    'agentContext:inspect',
    async (_event, target?: AgentContextInspectTarget): Promise<AgentContextReport> => {
      const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
      return inspectAgentContextOnTarget(resolveSkillDiscoveryTarget(parsedTarget))
    }
  )
}
