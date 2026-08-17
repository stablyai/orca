import type { HerdrPtyBinding } from './herdr-pty-types'
import {
  getHerdrBindingAgentState,
  getHerdrBindingBufferSnapshot
} from './herdr-pty-binding-queries'
import type { PtyProviderBufferSnapshot } from '../../types'
import type { HerdrAgentInfo } from './herdr-runtime-contract'
import type { HerdrRuntimeManager } from './herdr-runtime-manager'

export async function getHerdrAgentState(binding: HerdrPtyBinding): Promise<HerdrAgentInfo | null> {
  return await getHerdrBindingAgentState(binding)
}

export async function listHerdrAgents(
  managers: Map<string, HerdrRuntimeManager>
): Promise<HerdrAgentInfo[]> {
  const allAgents: HerdrAgentInfo[] = []
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

export async function getHerdrBufferSnapshot(
  binding: HerdrPtyBinding,
  scrollbackRows?: number,
  source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'
): Promise<PtyProviderBufferSnapshot | null> {
  return await getHerdrBindingBufferSnapshot(binding, scrollbackRows, source)
}
