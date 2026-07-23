import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentType } from '../../../src/shared/agent-status-types'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../src/shared/skills'
import { getNativeChatAgentProfile } from '../../../src/shared/native-chat-agent-profiles'
import { isNativeChatSkillForAgent } from '../../../src/shared/native-chat/native-chat-skill-ownership'
import type { RpcClient } from '../transport/rpc-client'
import {
  getMobileTerminalDiagnosticErrorName,
  logMobileTerminalDiagnostic,
  shortenMobileTerminalDiagnosticId
} from './mobile-terminal-diagnostics'

const SKILL_DISCOVERY_DEBOUNCE_MS = 120
const SKILL_DISCOVERY_TIMEOUT_MS = 30_000

export type MobileNativeChatSkillDiscovery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  skills: readonly DiscoveredSkill[]
  errorKind?: 'unavailable' | 'timeout' | 'unknown'
  retry: () => void
}

type StoredDiscoveryState = Omit<MobileNativeChatSkillDiscovery, 'retry'> & {
  client: RpcClient | null
  worktreeId: string
  agent: AgentType | null
}

class MobileSkillDiscoveryError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

let discoveryCache = new WeakMap<RpcClient, Map<string, SkillDiscoveryResult>>()
let inFlightDiscovery = new WeakMap<RpcClient, Map<string, Promise<SkillDiscoveryResult>>>()

export function useMobileNativeChatSkills(args: {
  client: RpcClient | null
  worktreeId: string
  agent: AgentType | null
}): MobileNativeChatSkillDiscovery {
  const { client, worktreeId, agent } = args
  const profile = getNativeChatAgentProfile(agent)
  const sequenceRef = useRef(0)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [state, setState] = useState<StoredDiscoveryState>(() =>
    storedState('idle', client, worktreeId, agent)
  )

  useEffect(() => {
    const sequence = ++sequenceRef.current
    if (!client || !agent || !profile) {
      setState(storedState('idle', client, worktreeId, agent))
      return
    }
    const cached = discoveryCache.get(client)?.get(worktreeId)
    if (cached) {
      setState(readyState(client, worktreeId, agent, cached))
      return
    }
    setState(storedState('loading', client, worktreeId, agent))
    const timer = setTimeout(() => {
      void getOrStartDiscovery(client, worktreeId).then(
        (result) => {
          if (sequenceRef.current !== sequence) {
            return
          }
          setState(readyState(client, worktreeId, agent, result))
        },
        (reason) => {
          if (sequenceRef.current !== sequence) {
            return
          }
          const errorKind = classifyDiscoveryError(reason)
          logMobileTerminalDiagnostic('skill-discovery-error', {
            worktree: shortenMobileTerminalDiagnosticId(worktreeId),
            errorKind,
            rpcCode: reason instanceof MobileSkillDiscoveryError ? reason.code : null,
            errorName: getMobileTerminalDiagnosticErrorName(reason)
          })
          setState({
            ...storedState('error', client, worktreeId, agent),
            errorKind
          })
        }
      )
    }, SKILL_DISCOVERY_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      if (sequenceRef.current === sequence) {
        sequenceRef.current++
      }
    }
  }, [agent, client, profile, retryGeneration, worktreeId])

  const retry = useCallback(() => {
    if (client) {
      discoveryCache.get(client)?.delete(worktreeId)
    }
    setState(storedState(client && profile ? 'loading' : 'idle', client, worktreeId, agent))
    setRetryGeneration((generation) => generation + 1)
  }, [agent, client, profile, worktreeId])

  return useMemo(() => {
    const matchesContext =
      state.client === client && state.worktreeId === worktreeId && state.agent === agent
    const effective = matchesContext
      ? state
      : storedState(client && profile ? 'loading' : 'idle', client, worktreeId, agent)
    return {
      status: effective.status,
      skills: effective.skills,
      ...(effective.errorKind ? { errorKind: effective.errorKind } : {}),
      retry
    }
  }, [agent, client, profile, retry, state, worktreeId])
}

function storedState(
  status: StoredDiscoveryState['status'],
  client: RpcClient | null,
  worktreeId: string,
  agent: AgentType | null
): StoredDiscoveryState {
  return { status, skills: [], client, worktreeId, agent }
}

function readyState(
  client: RpcClient,
  worktreeId: string,
  agent: AgentType,
  result: SkillDiscoveryResult
): StoredDiscoveryState {
  return {
    status: 'ready',
    skills: result.skills.filter((skill) => isNativeChatSkillForAgent(agent, skill, result)),
    client,
    worktreeId,
    agent
  }
}

function getOrStartDiscovery(client: RpcClient, worktreeId: string): Promise<SkillDiscoveryResult> {
  let clientRequests = inFlightDiscovery.get(client)
  if (!clientRequests) {
    clientRequests = new Map()
    inFlightDiscovery.set(client, clientRequests)
  }
  const existing = clientRequests.get(worktreeId)
  if (existing) {
    return existing
  }
  const request = client
    .sendRequest('skills.discover', { worktreeId }, { timeoutMs: SKILL_DISCOVERY_TIMEOUT_MS })
    .then((response) => {
      if (!response.ok) {
        throw new MobileSkillDiscoveryError(response.error.message, response.error.code)
      }
      const result = response.result as SkillDiscoveryResult
      let clientCache = discoveryCache.get(client)
      if (!clientCache) {
        clientCache = new Map()
        discoveryCache.set(client, clientCache)
      }
      clientCache.set(worktreeId, result)
      return result
    })
    .finally(() => {
      if (clientRequests.get(worktreeId) === request) {
        clientRequests.delete(worktreeId)
      }
    })
  clientRequests.set(worktreeId, request)
  return request
}

function classifyDiscoveryError(reason: unknown): 'unavailable' | 'timeout' | 'unknown' {
  if (reason instanceof MobileSkillDiscoveryError && reason.code === 'method_not_found') {
    return 'unavailable'
  }
  const message = reason instanceof Error ? reason.message : String(reason)
  return /timed?\s*out|timeout/i.test(message) ? 'timeout' : 'unknown'
}

export function resetMobileNativeChatSkillDiscoveryCacheForTests(): void {
  discoveryCache = new WeakMap()
  inFlightDiscovery = new WeakMap()
}
