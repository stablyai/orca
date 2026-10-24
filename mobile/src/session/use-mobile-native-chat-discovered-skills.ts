import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { DiscoveredSkill } from '../../../src/shared/skills'
import { isNativeChatSkillForAgent } from '../../../src/shared/native-chat-skill-visibility'
import { nativeChatSkillDiscoveryRun } from './native-chat-skill-discovery-operation'

/** Fetches the worktree's installed skills once per worktree/agent, filtered to
 *  what that agent can be offered; the picker namespaces plugin rows. Any
 *  failure — including a host that predates the mobile-allowed method —
 *  silently leaves the catalog and session-reported skills standing. */
export function useMobileNativeChatDiscoveredSkills(args: {
  client: RpcClient | null
  worktreeId: string
  agent: string | null
}): { discoveredSkills: readonly DiscoveredSkill[] } {
  const { client, worktreeId, agent } = args
  const [discoveredSkills, setDiscoveredSkills] = useState<readonly DiscoveredSkill[]>([])
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    setDiscoveredSkills([])
    if (!client || !agent) {
      return
    }
    void (async () => {
      const response = await nativeChatSkillDiscoveryRun.request(client, { worktreeId })
      if (generationRef.current !== generation) {
        return
      }
      const result = nativeChatSkillDiscoveryRun.interpret(response)
      setDiscoveredSkills(
        result.skills.filter((skill) => isNativeChatSkillForAgent(agent, skill, result))
      )
    })().catch(() => {})
  }, [client, worktreeId, agent])

  return { discoveredSkills }
}
