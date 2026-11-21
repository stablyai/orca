import { describe, expect, it } from 'vitest'
import {
  listAgentProcessRoots,
  noteAgentProcessChat,
  registerAgentProcess
} from './agent-process-registry'

describe('agent process registry', () => {
  it("keeps a reused pid's new chat when the old run's release arrives late", () => {
    const releaseOld = registerAgentProcess(4242)
    noteAgentProcessChat(4242, 'old-chat')
    const releaseNew = registerAgentProcess(4242)
    releaseOld()
    noteAgentProcessChat(4242, 'new-chat')

    expect(listAgentProcessRoots()).toEqual([{ pid: 4242, agentSessionId: 'new-chat' }])
    releaseNew()
    expect(listAgentProcessRoots()).toEqual([])
  })
})
