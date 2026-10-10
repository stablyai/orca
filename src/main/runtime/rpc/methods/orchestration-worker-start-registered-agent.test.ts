// Every agent the host registers for native chat starts as a native-chat worker, the same as a
// chat opened any other way; an agent with no native chat still starts in a terminal.

import { describe, expect, it } from 'vitest'
import { decideAgentLaunchMode } from '../../../agent-launch/agent-launch-mode'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from '../../structured-agent-runtime-registrations'
import {
  decideWorkerStartMode,
  resolveWorkerStartModeOnHost
} from './orchestration-worker-start-mode'

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true
} as const

const REGISTERED_AGENTS = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
  ({ definition }) => definition.agent
).filter(isTuiAgent)

describe('a worker for a registered native-chat agent', () => {
  it('covers every registered agent, the ACP and Pi agents included', () => {
    expect(REGISTERED_AGENTS).toHaveLength(STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.length)
    expect(REGISTERED_AGENTS).toEqual(expect.arrayContaining(['grok', 'opencode', 'omp', 'pi']))
  })

  it.each(REGISTERED_AGENTS)('starts %s structured, as any other launch does', async (agent) => {
    const mode = decideWorkerStartMode({ params: { agent }, settings: STRUCTURED_PREFERENCE })
    expect(mode).toMatchObject({ mode: 'structured', reason: 'user_default' })
    expect(
      decideAgentLaunchMode({ placement: { agent }, settings: STRUCTURED_PREFERENCE })
    ).toMatchObject({ mode: 'structured' })
    const host = { getStructuredAgentSessionCreateSupport: async () => ({ supported: true }) }
    expect(await resolveWorkerStartModeOnHost(host, mode, 'wt-1', agent)).toMatchObject({
      mode: 'structured'
    })
  })

  it('still starts a terminal worker when the host refuses that agent here', async () => {
    const mode = decideWorkerStartMode({
      params: { agent: 'opencode' },
      settings: STRUCTURED_PREFERENCE
    })
    const host = {
      getStructuredAgentSessionCreateSupport: async () => ({
        supported: false,
        reason: 'agent' as const
      })
    }
    expect(await resolveWorkerStartModeOnHost(host, mode, 'wt-1', 'opencode')).toMatchObject({
      mode: 'terminal',
      reason: 'structured_unsupported_on_host'
    })
  })

  it('starts an agent with no native chat as a terminal worker', () => {
    expect(
      decideWorkerStartMode({ params: { agent: 'gemini' }, settings: STRUCTURED_PREFERENCE })
    ).toMatchObject({ mode: 'terminal', reason: 'agent_without_structured_session' })
  })

  it('starts a terminal agent while the setting is off, as Claude does', () => {
    for (const agent of ['opencode', 'claude']) {
      expect(
        decideWorkerStartMode({
          params: { agent },
          settings: { experimentalNativeChat: false }
        })
      ).toMatchObject({ mode: 'terminal', preferred: 'terminal', reason: 'user_default' })
    }
  })
})
