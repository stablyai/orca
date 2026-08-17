import type { HerdrPtyBinding } from './herdr-pty-types'
import { getHerdrBindingAgentState } from './herdr-pty-binding-queries'
import type { HerdrRuntimeManager } from './herdr-runtime-manager'

export async function getHerdrAgentState(binding: HerdrPtyBinding): Promise<{
  agent: string | null
  agent_status: string
  interactive_ready?: boolean
  launch_pending?: boolean
  state_labels?: Record<string, string>
  display_agent?: string | null
  name?: string | null
} | null> {
  return await getHerdrBindingAgentState(binding)
}

export async function listHerdrAgents(managers: Map<string, HerdrRuntimeManager>): Promise<
  {
    agent: string | null
    agent_status: string
    interactive_ready?: boolean
    launch_pending?: boolean
    state_labels?: Record<string, string>
    display_agent?: string | null
    name?: string | null
  }[]
> {
  const allAgents: {
    agent: string | null
    agent_status: string
    interactive_ready?: boolean
    launch_pending?: boolean
    state_labels?: Record<string, string>
    display_agent?: string | null
    name?: string | null
  }[] = []
  for (const manager of managers.values()) {
    for (const sessionName of manager.listSessionNames()) {
      try {
        const rollup = await manager.listAgents(sessionName)
        allAgents.push(...rollup.agents)
      } catch {
        // Ignore errors for stale managers
      }
    }
  }
  return allAgents
}
