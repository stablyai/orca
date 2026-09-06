import { describe, expect, it } from 'vitest'
import { AGENT_WORKING_MODES } from '../../../src/shared/agent-status-types'
import { MobileWebNativeChatAgentStatusSchema } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { mobileWebSessionAgentStatus } from './mobile-web-session-agent-status-projection'

const HOST_STATUS = {
  state: 'working',
  agentType: 'claude',
  model: 'claude-opus-5',
  workingMode: 'monitoring',
  lastAssistantMessage: 'Ran the tests',
  lastAssistantMessageIsToolOutput: true
}

describe('mobile web session agent status projection', () => {
  it('carries the fields the hosted chat reads to decide working and streaming', () => {
    const status = mobileWebSessionAgentStatus(HOST_STATUS)

    expect(status).toMatchObject({
      model: 'claude-opus-5',
      workingMode: 'monitoring',
      lastAssistantMessageIsToolOutput: true
    })
    expect(MobileWebNativeChatAgentStatusSchema.safeParse(status).success).toBe(true)
  })

  it('drops an unrecognized working mode rather than failing the snapshot', () => {
    const status = mobileWebSessionAgentStatus({ ...HOST_STATUS, workingMode: 'hibernating' })

    expect(status).not.toHaveProperty('workingMode')
    expect(MobileWebNativeChatAgentStatusSchema.safeParse(status).success).toBe(true)
  })

  it('drops a model past the contract bound', () => {
    const status = mobileWebSessionAgentStatus({ ...HOST_STATUS, model: 'm'.repeat(121) })

    expect(status).not.toHaveProperty('model')
    expect(MobileWebNativeChatAgentStatusSchema.safeParse(status).success).toBe(true)
  })

  it('drops a non-boolean tool-output flag', () => {
    const status = mobileWebSessionAgentStatus({
      ...HOST_STATUS,
      lastAssistantMessageIsToolOutput: 'yes'
    })

    expect(status).not.toHaveProperty('lastAssistantMessageIsToolOutput')
  })

  it('refuses a value that is not a live agent status', () => {
    expect(mobileWebSessionAgentStatus({ state: 'sleeping' })).toBeUndefined()
    expect(mobileWebSessionAgentStatus(null)).toBeUndefined()
  })

  // The contract inlines the working-mode set because the page bundle cannot reach
  // `agent-status-types`; a mode the host publishes and the wire refuses would be silently lost.
  it('accepts exactly the working modes the host can publish', () => {
    for (const mode of AGENT_WORKING_MODES) {
      expect(
        MobileWebNativeChatAgentStatusSchema.safeParse({ state: 'working', workingMode: mode })
          .success
      ).toBe(true)
    }
  })
})
