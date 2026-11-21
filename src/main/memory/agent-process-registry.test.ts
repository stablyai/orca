import { describe, expect, it } from 'vitest'
import {
  agentRegistrationMark,
  listAgentProcessRoots,
  noteAgentProcessChat,
  registerAgentProcess
} from './agent-process-registry'

describe('agent process registry', () => {
  it('leaves a run registered during a sample out of that sample', () => {
    const mark = agentRegistrationMark()
    const release = registerAgentProcess(4141)
    noteAgentProcessChat(4141, 'new-chat')

    expect(listAgentProcessRoots(mark)).toEqual([])
    expect(listAgentProcessRoots(agentRegistrationMark())).toEqual([
      { pid: 4141, agentSessionId: 'new-chat' }
    ])
    release()
  })

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

  it('never shows the old chat on a reused pid, even after the new run ends first', () => {
    const releaseOld = registerAgentProcess(4343)
    noteAgentProcessChat(4343, 'old-chat')
    const releaseNew = registerAgentProcess(4343)

    // The new run hasn't linked a chat yet, so nothing is counted under the old one.
    expect(listAgentProcessRoots()).toEqual([])
    releaseNew()
    expect(listAgentProcessRoots()).toEqual([])
    releaseOld()
    expect(listAgentProcessRoots()).toEqual([])
  })

  it("never shows the old chat when a new wrapper reuses an exited wrapper's pid", () => {
    const releaseOld = registerAgentProcess(4444, 4300)
    noteAgentProcessChat(4300, 'old-chat')
    const releaseNew = registerAgentProcess(4444, 4400)

    // The new run hasn't linked a chat yet, so nothing is counted under the old one.
    expect(listAgentProcessRoots()).toEqual([])
    releaseOld()
    noteAgentProcessChat(4400, 'new-chat')
    expect(listAgentProcessRoots()).toEqual([{ pid: 4444, agentSessionId: 'new-chat' }])
    releaseNew()
    expect(listAgentProcessRoots()).toEqual([])
  })

  it('stops counting a pid once its process has exited, before its cleanup releases it', () => {
    let exited = false
    const release = registerAgentProcess(4545, 4545, () => !exited)
    noteAgentProcessChat(4545, 'chat')
    exited = true

    expect(listAgentProcessRoots()).toEqual([])
    release()
  })
})
