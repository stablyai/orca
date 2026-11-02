import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { z } from 'zod'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import { isNativeChatSkillForAgent } from '../../../../../src/shared/native-chat-skill-visibility'
import type { RpcClient } from '../../../transport/rpc-client'
import { nativeChatSkillDiscoveryRead } from '../../mobile-session-read-operations'
import type { skillDiscoveryReplySchema } from '../../session-read-reply-schema'

type SkillDiscoveryReply = z.output<typeof skillDiscoveryReplySchema>

type Scan = { status: 'loading' | 'error' } | { status: 'ready'; reply: SkillDiscoveryReply }

const NO_SKILLS: NativeChatSkillDiscoverySnapshot = { status: 'ready', skills: [] }

/** The host scans the workspace named by id (desktop sends the pane's folder); hosts without that scan list none. */
export function useMobileNativeChatSkills(args: {
  client: RpcClient | null
  worktreeId: string
  agent: string | null
  supported: boolean
}): { nativeChatSkills: NativeChatSkillDiscoverySnapshot; loadNativeChatSkills: () => void } {
  const { client, worktreeId, agent, supported } = args
  const [scans, setScans] = useState<{
    client: RpcClient | null
    generation: number
    byKey: Map<string, Scan>
  }>({
    client: null,
    generation: 0,
    byKey: new Map()
  })
  const generation = client?.getGeneration?.() ?? 0
  const scan =
    scans.client === client && scans.generation === generation
      ? scans.byKey.get(worktreeId)
      : undefined
  // Read through refs so a settled failure cannot recreate the loader and refire the menu's request.
  const scanRef = useRef(scan)
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    scanRef.current = scan
    clientRef.current = client
  }, [client, scan])

  const loadNativeChatSkills = useCallback(() => {
    // The phone has no Retry button, so the next menu opening retries a failed scan.
    const held = scanRef.current
    if (!client || !supported || (held && held.status !== 'error')) {
      return
    }
    // Read at request time: a same-state migration need not re-render before the menu opens.
    const generation = client.getGeneration?.() ?? 0
    const settle = (next: Scan): void => {
      // A reply from a replaced connection must not wipe the current one's scans.
      if (clientRef.current !== client || (client.getGeneration?.() ?? 0) !== generation) {
        return
      }
      setScans((current) => {
        const byKey = new Map(
          current.client === client && current.generation === generation ? current.byKey : []
        )
        byKey.set(worktreeId, next)
        return { client, generation, byKey }
      })
    }
    settle({ status: 'loading' })
    void nativeChatSkillDiscoveryRead
      .request(client, { worktreeId })
      .then((response) => {
        const accepted = nativeChatSkillDiscoveryRead.interpret(response)
        settle(accepted.accepted ? { status: 'ready', reply: accepted.value } : { status: 'error' })
      })
      .catch(() => settle({ status: 'error' }))
  }, [client, supported, worktreeId])

  const nativeChatSkills = useMemo<NativeChatSkillDiscoverySnapshot>(() => {
    if (!agent || !supported) {
      return NO_SKILLS
    }
    if (scan?.status !== 'ready') {
      return { status: scan?.status ?? 'idle', skills: [] }
    }
    const { reply } = scan
    return {
      status: 'ready',
      skills: reply.skills.filter((skill) => isNativeChatSkillForAgent(agent, skill, reply))
    }
  }, [agent, scan, supported])

  return { nativeChatSkills, loadNativeChatSkills }
}
