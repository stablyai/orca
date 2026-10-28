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
  const [scans, setScans] = useState<{ client: RpcClient | null; byKey: Map<string, Scan> }>({
    client: null,
    byKey: new Map()
  })
  const key = `${client?.getGeneration?.() ?? 0}\0${worktreeId}`
  const scan = scans.client === client ? scans.byKey.get(key) : undefined
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
    const settle = (next: Scan): void => {
      // A reply from a replaced connection must not wipe the current one's scans.
      if (clientRef.current !== client) {
        return
      }
      setScans((current) => {
        const byKey = new Map(current.client === client ? current.byKey : [])
        byKey.set(key, next)
        return { client, byKey }
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
  }, [client, key, supported, worktreeId])

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
