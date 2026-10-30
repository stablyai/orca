import { describe, expect, it } from 'vitest'
import {
  CHIP_APPROVE,
  CHIP_DONE,
  CHIP_OFFLINE,
  CHIP_REPLY,
  CHIP_STOPPED,
  CHIP_WORKING,
  buildDisconnectedPayload,
  buildFinalPayload,
  buildLingerPayload,
  buildLivePayload,
  liveAlertTarget,
  type LivePayloadInput
} from './live-alert-payload'
import type { LiveAgent } from './live-alert-types'

const LEAF = '0f8fad5b-d9cb-469f-a165-70867728950e'

function agent(key: string, overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    key,
    hostId: 'host-1',
    hostName: 'Desk',
    worktreeId: 'wt-1',
    workspace: 'demo-repo',
    executionHost: null,
    paneKey: `tab-1:${LEAF}`,
    phase: 'working',
    need: null,
    agentType: 'opencode',
    prompt: '',
    lastAssistantMessage: 'Creating hello.txt now. Then ping.',
    toolName: null,
    toolInput: null,
    stateStartedAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function input(agents: LiveAgent[], overrides: Partial<LivePayloadInput> = {}): LivePayloadInput {
  return {
    startedAt: 1000,
    sessionKeys: new Set(agents.map((each) => each.key)),
    agents,
    ...overrides
  }
}

describe('buildLivePayload', () => {
  it('describes one working agent from its reply', () => {
    const payload = buildLivePayload(input([agent('a')]))
    expect(payload).toMatchObject({
      phase: 'working',
      title: 'Agent working',
      text: 'Creating hello.txt now.',
      subText: 'OpenCode · demo-repo',
      chipText: CHIP_WORKING,
      startedAt: 1000,
      progressTotal: null,
      indeterminate: true
    })
    expect(JSON.parse(payload?.targetJson ?? 'null')).toEqual({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      paneKey: `tab-1:${LEAF}`
    })
  })

  it('asks for approval with the permission and its target', () => {
    const waiting = agent('a', {
      phase: 'waiting',
      need: 'approval',
      toolName: 'external_directory',
      toolInput: 'F:/demo-outside/note.txt'
    })
    expect(buildLivePayload(input([waiting]))).toMatchObject({
      phase: 'waiting',
      title: 'Needs your approval',
      text: 'Allow outside access: note.txt',
      chipText: CHIP_APPROVE,
      indeterminate: false
    })
  })

  it('asks for an answer to a question', () => {
    const waiting = agent('a', { phase: 'waiting', need: 'input' })
    expect(buildLivePayload(input([waiting]))).toMatchObject({
      title: 'Needs your input',
      text: 'Waiting for your answer',
      chipText: CHIP_REPLY
    })
  })

  it('counts several working agents and shows the session progress', () => {
    const payload = buildLivePayload(input([agent('a'), agent('b', { updatedAt: 5 })]))
    expect(payload).toMatchObject({
      title: '2 agents working',
      subText: 'OpenCode · demo-repo · +1 more',
      progressTotal: 2,
      progressFinished: 0,
      indeterminate: false
    })
  })

  it('leads with the waiting agent while another one works', () => {
    const waiting = agent('b', {
      phase: 'waiting',
      need: 'approval',
      toolName: 'bash',
      toolInput: 'ls'
    })
    const payload = buildLivePayload(input([agent('a'), waiting]))
    expect(payload).toMatchObject({ title: 'Needs your approval', text: 'Allow command: ls' })
    expect(payload?.subText).toBe('OpenCode · demo-repo · +1 more')
  })

  it('counts two waiting agents', () => {
    const first = agent('a', { phase: 'waiting', need: 'input' })
    const second = agent('b', { phase: 'waiting', need: 'approval', toolName: 'bash' })
    expect(buildLivePayload(input([first, second]))?.title).toBe('2 agents need you')
  })

  it('counts finished session agents in the progress bar', () => {
    const agents = [agent('a'), agent('b', { phase: 'done' }), agent('c', { phase: 'done' })]
    const payload = buildLivePayload(input(agents))
    expect(payload?.title).toBe('Agent working')
    expect(payload).toMatchObject({ progressTotal: 3, progressFinished: 2 })
  })

  it('names the desktop when the session spans several', () => {
    const other = agent('b', { hostId: 'host-2', hostName: 'Laptop', phase: 'done' })
    const payload = buildLivePayload(input([agent('a'), other]))
    expect(payload?.subText).toBe('OpenCode · demo-repo · Desk')
  })

  it('shows the precise ask of an agent waiting for an answer', () => {
    const waiting = agent('a', { phase: 'waiting', need: 'input' })
    expect(buildLivePayload(input([waiting]))?.text).toBe('Waiting for your answer')
  })

  it('sanitizes and truncates the status line', () => {
    const noisy = agent('a', { lastAssistantMessage: `\u001b[1m${'word '.repeat(60)}\u001b[0m` })
    const text = buildLivePayload(input([noisy]))?.text ?? ''
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text.endsWith('…')).toBe(true)
    expect(text.includes('\u001b')).toBe(false)
  })

  it('is null when no agent is active', () => {
    expect(buildLivePayload(input([agent('a', { phase: 'done' })]))).toBeNull()
  })
})

describe('finished payloads', () => {
  it('lingers on Done, then leaves a dismissable notification', () => {
    const done = agent('a', { phase: 'done', lastAssistantMessage: 'Created hello.txt.' })
    expect(buildLingerPayload(input([done]))).toMatchObject({
      phase: 'lingering',
      title: 'Done',
      text: 'Created hello.txt.',
      chipText: CHIP_DONE
    })
    expect(buildFinalPayload(input([done]))).toMatchObject({
      phase: 'final',
      title: 'Done',
      chipText: null
    })
  })

  it('counts done, failed and stopped agents', () => {
    const sessions = [
      [agent('a', { phase: 'done' }), agent('b', { phase: 'done' })],
      [agent('a', { phase: 'failed' })],
      [agent('a', { phase: 'failed' }), agent('b', { phase: 'stopped' })],
      [agent('a', { phase: 'done' }), agent('b', { phase: 'stopped' })]
    ]
    expect(sessions.map((agents) => buildFinalPayload(input(agents)).title)).toEqual([
      '2 agents done',
      'Agent stopped',
      '2 agents stopped',
      '1 done, 1 stopped'
    ])
    const stopped = buildLingerPayload(input([agent('a', { phase: 'failed' })]))
    expect(stopped.chipText).toBe(CHIP_STOPPED)
  })

  it('reports a lost desktop', () => {
    expect(buildDisconnectedPayload(5, 'working')).toMatchObject({
      phase: 'working',
      title: 'Disconnected',
      chipText: CHIP_OFFLINE,
      targetJson: null
    })
    expect(buildDisconnectedPayload(5, 'final').chipText).toBeNull()
  })

  it('keeps every chip word to 7 characters or fewer', () => {
    const chips = [CHIP_WORKING, CHIP_APPROVE, CHIP_REPLY, CHIP_DONE, CHIP_STOPPED, CHIP_OFFLINE]
    expect(Math.max(...chips.map((chip) => chip.length))).toBeLessThanOrEqual(7)
  })
})

describe('liveAlertTarget', () => {
  it('opens the host session pane, with the runtime server when there is one', () => {
    const mirrored = agent('a', {
      paneKey: `web-terminal-${encodeURIComponent('tab-9::surface')}:${LEAF}`,
      executionHost: 'runtime:server-1'
    })
    expect(liveAlertTarget(mirrored)).toEqual({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      paneKey: `tab-9:${LEAF}`,
      executionHost: 'runtime:server-1'
    })
    expect(liveAlertTarget(agent('a'))).not.toHaveProperty('executionHost')
  })
})
