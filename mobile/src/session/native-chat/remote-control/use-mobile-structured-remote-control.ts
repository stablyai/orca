import { useCallback, useMemo } from 'react'
import { AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import {
  agentSessionProviderRemoteControlIsOn,
  agentSessionProviderRemoteControlIsPending,
  type AgentSessionProviderRemoteControl,
  type AgentSessionProviderRemoteControlResult
} from '../../../../../src/shared/agent-session/remote-control/agent-session-provider-remote-control'
import type { StructuredAgentSessionComposerOptions } from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import { useRouteRelaysCapability } from '../../../worktree/execution-hosts/workspace-server-context'
import type { MobileStructuredAgentSessionArgs } from '../agent-session/mobile-structured-agent-session-contract'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'
import {
  useMobileStructuredSessionProviderRemoteControl,
  useMobileStructuredSessionProviderRemoteControlChoice
} from '../agent-session/use-mobile-structured-session-host-execution'

type RemoteControlCommands = Pick<StructuredAgentSessionComposerOptions, 'toggleRemoteControl'>

export type MobileStructuredRemoteControl = {
  /** The running agent's link as its host last published it; absent while off. */
  link: AgentSessionProviderRemoteControl | undefined
  /** Turned on while the agent is not running: it connects when the agent next starts. */
  pending: boolean
  toggle: () => Promise<boolean>
  /** Asks again after a failed link; a failed link counts as on, so toggling would turn it off. */
  retry: () => Promise<boolean>
}

/** A Claude chat's Remote Control on the phone: its link, and `/remote-control` (`/rc`). */
export function useMobileStructuredRemoteControl<TCommands extends object>(
  session: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'agent' | 'hostSupport' | 'enabled'
  >,
  commands: TCommands
): {
  /** Null where the host or route cannot save the choice. */
  remoteControl: MobileStructuredRemoteControl | null
  commands: TCommands & RemoteControlCommands
} {
  const { client, sessionId, agent, hostSupport, enabled } = session
  const relayed = useRouteRelaysCapability(AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY)
  const offered =
    enabled &&
    agent === 'claude' &&
    hostSupport?.providerRemoteControl === true &&
    hostSupport.statusFeed === true &&
    relayed &&
    !!client &&
    !!sessionId
  const link = useMobileStructuredSessionProviderRemoteControl({
    client,
    sessionId,
    enabled: offered
  })
  const choice = useMobileStructuredSessionProviderRemoteControlChoice({
    client,
    sessionId,
    enabled: offered
  })
  const pending = agentSessionProviderRemoteControlIsPending({ link, choice })
  const on = agentSessionProviderRemoteControlIsOn({ link, choice })
  const set = useCallback(
    async (choice: 'on' | 'off'): Promise<boolean> => {
      if (!client || !sessionId) {
        return false
      }
      const result = await callAgentSession<AgentSessionProviderRemoteControlResult>(
        client,
        'agentSession.providerRemoteControl',
        { sessionId, choice }
      )
      return result.status === 'ok'
    },
    [client, sessionId]
  )
  const toggle = useCallback(() => set(on ? 'off' : 'on'), [set, on])
  const retry = useCallback(() => set('on'), [set])
  return useMemo(
    () => ({
      remoteControl: offered ? { link, pending, toggle, retry } : null,
      commands: { ...commands, toggleRemoteControl: offered ? toggle : undefined }
    }),
    [commands, link, offered, pending, toggle, retry]
  )
}
