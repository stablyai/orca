import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { SlashCommandSuggestion } from '../../../src/shared/native-chat-slash-commands'
import {
  discoveredSkillTokenName,
  isNativeChatSkillForAgent
} from '../../../src/shared/native-chat-skill-visibility'
import { nativeChatSkillDiscoveryRun } from './native-chat-skill-discovery-operation'

/** Fetches the worktree's installed skills once per worktree/agent and maps
 *  them to described suggestion rows. Any failure — including a host that
 *  predates the mobile-allowed method — silently leaves the curated catalog
 *  and any session-reported skills standing. */
export function useMobileNativeChatDiscoveredSkills(args: {
  client: RpcClient | null
  worktreeId: string
  agent: string | null
}): { skillSuggestions: readonly SlashCommandSuggestion[] } {
  const { client, worktreeId, agent } = args
  const [skillSuggestions, setSkillSuggestions] = useState<readonly SlashCommandSuggestion[]>([])
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    setSkillSuggestions([])
    if (!client || !agent) {
      return
    }
    void (async () => {
      const response = await nativeChatSkillDiscoveryRun.request(client, { worktreeId })
      if (generationRef.current !== generation) {
        return
      }
      const result = nativeChatSkillDiscoveryRun.interpret(response)
      setSkillSuggestions(
        result.skills
          .filter((skill) => isNativeChatSkillForAgent(agent, skill, result))
          .map((skill) => ({
            name: discoveredSkillTokenName(skill),
            ...(skill.description ? { description: skill.description } : {})
          }))
      )
    })().catch(() => {})
  }, [client, worktreeId, agent])

  return { skillSuggestions }
}
