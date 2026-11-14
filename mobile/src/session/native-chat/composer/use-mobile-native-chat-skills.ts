import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import { isNativeChatSkillForAgent } from '../../../../../src/shared/native-chat/input/native-chat-skill-visibility'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { defineHostQuery, useHostQuery } from '../../../query/host-query'
import { hostQueryKey } from '../../../query/host-query-key'
import { useWorkspaceExecutionHost } from '../../../navigation/workspace-execution-host'
import { nativeChatSkillDiscoveryRead } from './mobile-native-chat-skill-operations'

const NO_SKILLS: NativeChatSkillDiscoverySnapshot = { status: 'ready', skills: [] }
const NO_INPUT = {}

// A workspace's last scan, so a reopened composer's menus list its skills at once.
const skillDiscoveryQuery = defineHostQuery({
  family: 'skills.discover',
  fetch: async (client, target) => {
    const read = nativeChatSkillDiscoveryRead.interpret(
      await nativeChatSkillDiscoveryRead.request(client, { worktreeId: target.worktree ?? '' })
    )
    if (!read.accepted) {
      throw new Error('Skill scan unavailable')
    }
    return read.value
  },
  staleTime: 60_000
})

/** The host scans the workspace named by id (desktop sends the pane's folder); hosts without that scan list none. */
export function useMobileNativeChatSkills(args: {
  hostId: string
  client: RpcClient | null
  worktreeId: string
  agent: string | null
  supported: boolean
}): { nativeChatSkills: NativeChatSkillDiscoverySnapshot; loadNativeChatSkills: () => void } {
  const { hostId, client, worktreeId, agent, supported } = args
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const queryClient = useQueryClient()
  // The scan runs once a menu asks for it; a scan this document already holds shows at once.
  const [demanded, setDemanded] = useState(false)
  // A host that stops supporting the scan (a reconnect re-probes it) rescans on the next demand, not on its return.
  if (!supported && demanded) {
    setDemanded(false)
  }
  const scan = useHostQuery(
    skillDiscoveryQuery,
    { hostId, client },
    { exec, worktree: worktreeId },
    NO_INPUT,
    { enabled: supported && demanded }
  )
  const scanKey = useMemo(
    () =>
      hostQueryKey(hostId, skillDiscoveryQuery.family, { exec, worktree: worktreeId }, NO_INPUT),
    [exec, hostId, worktreeId]
  )

  // Reads the scan's state from the client, so a settled failure cannot recreate the loader and refire the menu's request.
  const loadNativeChatSkills = useCallback(() => {
    if (!client || !supported) {
      return
    }
    // The first demand enables the query, which fetches a missing or failed scan by itself.
    setDemanded(true)
    // The phone has no Retry button, so the next menu opening retries a failed scan; a still-disabled query is skipped.
    const state = queryClient.getQueryState(scanKey)
    if (state?.status === 'error' && state.data === undefined && state.fetchStatus === 'idle') {
      void queryClient.refetchQueries({ queryKey: scanKey, exact: true })
    }
  }, [client, queryClient, scanKey, supported])

  const { data, isError } = scan
  const nativeChatSkills = useMemo<NativeChatSkillDiscoverySnapshot>(() => {
    if (!agent || !supported) {
      return NO_SKILLS
    }
    if (!data) {
      return { status: !demanded ? 'idle' : isError ? 'error' : 'loading', skills: [] }
    }
    return {
      status: 'ready',
      skills: data.skills.filter((skill) => isNativeChatSkillForAgent(agent, skill, data))
    }
  }, [agent, data, demanded, isError, supported])

  return { nativeChatSkills, loadNativeChatSkills }
}
