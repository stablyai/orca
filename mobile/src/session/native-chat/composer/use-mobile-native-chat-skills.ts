import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import { isNativeChatSkillForAgent } from '../../../../../src/shared/native-chat/input/native-chat-skill-visibility'
import type { RpcClient } from '../../../transport/rpc-client'
import { defineHostQuery, useHostQuery } from '../../../query/host-query'
import { useWorkspaceExecutionHost } from '../../../navigation/workspace-execution-host'
import { nativeChatSkillDiscoveryRead } from '../../mobile-session-read-operations'

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
  const target = useMemo(() => ({ exec, worktree: worktreeId }), [exec, worktreeId])
  // The scan runs once a menu asks for it; a scan this document already holds shows at once.
  const [demanded, setDemanded] = useState(false)
  const scan = useHostQuery(skillDiscoveryQuery, { hostId, client }, target, NO_INPUT, {
    enabled: supported && demanded
  })
  // Read through refs so a settled failure cannot recreate the loader and refire the menu's request.
  const scanRef = useRef(scan)
  useLayoutEffect(() => {
    scanRef.current = scan
  }, [scan])

  const loadNativeChatSkills = useCallback(() => {
    if (!client || !supported) {
      return
    }
    setDemanded(true)
    // The phone has no Retry button, so the next menu opening retries a failed scan.
    const held = scanRef.current
    if (held.isError && held.data === undefined && !held.isFetching) {
      void held.refetch()
    }
  }, [client, supported])

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
