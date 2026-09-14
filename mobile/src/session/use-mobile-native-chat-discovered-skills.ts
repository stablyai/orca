import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { SlashCommandSuggestion } from '../../../src/shared/native-chat-slash-commands'
import {
  discoveredSkillTokenName,
  isNativeChatSkillForAgent
} from '../../../src/shared/native-chat-skill-visibility'
import type { SkillDiscoveryResult } from '../../../src/shared/skills'

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
      const response = await client.sendRequest('skills.discover', { worktreeId })
      if (!response.ok || generationRef.current !== generation) {
        return
      }
      const result = response.result as SkillDiscoveryResult
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
