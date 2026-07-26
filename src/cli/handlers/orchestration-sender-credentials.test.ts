import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

const originalSenderEnvironment = {
  terminalHandle: process.env.ORCA_TERMINAL_HANDLE,
  paneKey: process.env.ORCA_PANE_KEY,
  launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

describe('orchestration sender credential forwarding', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-token-worker'
  })

  afterEach(() => {
    restoreEnvironmentVariable('ORCA_TERMINAL_HANDLE', originalSenderEnvironment.terminalHandle)
    restoreEnvironmentVariable('ORCA_PANE_KEY', originalSenderEnvironment.paneKey)
    restoreEnvironmentVariable('ORCA_AGENT_LAUNCH_TOKEN', originalSenderEnvironment.launchToken)
    vi.restoreAllMocks()
  })

  it('forwards populated credentials for send', async () => {
    callMock.mockResolvedValue({ result: { message: { id: 'msg_send' } } })

    await ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['subject', 'status']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'status',
      body: undefined,
      type: undefined,
      priority: undefined,
      threadId: undefined,
      payload: undefined,
      senderPaneKey: 'tab_worker:leaf_worker',
      senderLaunchToken: 'launch-token-worker',
      devMode: false
    })
  })

  it('forwards populated credentials for reply', async () => {
    callMock.mockResolvedValue({ result: { message: { id: 'msg_reply' } } })

    await ORCHESTRATION_HANDLERS['orchestration reply']({
      flags: new Map<string, string | boolean>([
        ['id', 'msg_original'],
        ['body', 'answer']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.reply', {
      id: 'msg_original',
      body: 'answer',
      from: 'term_worker',
      senderPaneKey: 'tab_worker:leaf_worker',
      senderLaunchToken: 'launch-token-worker'
    })
  })

  it('forwards populated credentials for ask', async () => {
    callMock.mockResolvedValue({
      result: {
        answer: 'yes',
        messageId: 'msg_ask',
        threadId: 'thread_ask',
        timedOut: false
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await ORCHESTRATION_HANDLERS['orchestration ask']({
      flags: new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['question', 'Proceed?'],
        ['timeout-ms', '123']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.ask',
      {
        to: 'term_coord',
        question: 'Proceed?',
        options: undefined,
        timeoutMs: 123,
        from: 'term_worker',
        senderPaneKey: 'tab_worker:leaf_worker',
        senderLaunchToken: 'launch-token-worker'
      },
      { timeoutMs: 5_123 }
    )
  })
})
