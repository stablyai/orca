import { describe, expect, it, vi } from 'vitest'
import { CodexSideQuestManager } from './codex-side-quest-manager'
import { CodexAppServerTestProcess, initializeTestAppServer } from './codex-app-server-test-process'

function createScriptedProcess(
  onRequest?: (message: Record<string, unknown>, process: CodexAppServerTestProcess) => boolean
): CodexAppServerTestProcess {
  return new CodexAppServerTestProcess((message, process) => {
    if (initializeTestAppServer(message, process) || onRequest?.(message, process)) {
      return
    }
    if (message.method === 'config/read') {
      process.send({
        id: message.id,
        result: {
          config: {
            mcp_servers: {
              executor: { command: 'executor', enabled: true },
              jam: { url: 'https://example.test', enabled: true }
            }
          }
        }
      })
      return
    }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      process.send({
        id: message.id,
        result: {
          thread: {
            id: 'thread-1',
            sessionId: 'thread-1',
            ephemeral: false,
            turns: []
          }
        }
      })
      return
    }
    if (message.method === 'thread/read') {
      process.send({
        id: message.id,
        result: {
          thread: {
            id: 'thread-1',
            sessionId: 'thread-1',
            ephemeral: false,
            turns: [{ id: 'prior-turn' }]
          }
        }
      })
      return
    }
    if (message.method === 'turn/start') {
      process.send({
        id: message.id,
        result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
      })
      return
    }
    if (message.method === 'turn/interrupt') {
      process.send({ id: message.id, result: {} })
    }
  })
}

describe('CodexSideQuestManager', () => {
  it('starts an isolated read-only thread and streams turn events', async () => {
    const process = createScriptedProcess()
    const manager = new CodexSideQuestManager({
      processFactory: () => process.asProcess()
    })
    const events = vi.fn()
    manager.subscribe(events)

    const thread = await manager.startSession({ cwd: '/repo', model: 'gpt-test' })
    const startRequest = process.received.find((message) => message.method === 'thread/start')

    expect(thread.id).toBe('thread-1')
    expect(startRequest?.params).toMatchObject({
      cwd: '/repo',
      model: 'gpt-test',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: {
        mcp_servers: { executor: { enabled: false }, jam: { enabled: false } },
        features: { apps: false },
        model_reasoning_effort: 'low'
      }
    })

    const turn = await manager.startTurn({ threadId: thread.id, text: 'Explain the lockfile.' })
    process.send({
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, itemId: 'item-1', delta: 'Hello' }
    })
    process.send({
      method: 'item/completed',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        item: { type: 'agentMessage', id: 'item-1', text: 'Hello' },
        completedAtMs: 123
      }
    })
    process.send({
      method: 'turn/completed',
      params: { threadId: thread.id, turn: { id: turn.id, status: 'completed', items: [] } }
    })

    expect(turn.status).toBe('inProgress')
    expect(events.mock.calls.map(([event]) => event.type)).toEqual([
      'agent-message-delta',
      'item-completed',
      'turn-completed'
    ])
    await manager.interruptTurn(thread.id, turn.id)
    expect(process.received.some((message) => message.method === 'turn/interrupt')).toBe(true)
    manager.dispose()
  })

  it('reads persisted turns and rejects unsupported server requests', async () => {
    const process = createScriptedProcess()
    const manager = new CodexSideQuestManager({
      processFactory: () => process.asProcess()
    })
    await manager.startSession({ cwd: '/repo' })

    const thread = await manager.readSession('thread-1')
    process.send({ id: 70, method: 'item/tool/requestUserInput', params: {} })

    expect(thread.turns).toEqual([{ id: 'prior-turn' }])
    expect(process.received.at(-1)).toEqual({
      id: 70,
      error: { code: -32601, message: 'Unsupported app-server request: item/tool/requestUserInput' }
    })
    manager.dispose()
  })

  it('reconnects and resumes a durable thread after the process exits', async () => {
    const processes: CodexAppServerTestProcess[] = []
    const manager = new CodexSideQuestManager({
      processFactory: () => {
        const process = createScriptedProcess()
        processes.push(process)
        return process.asProcess()
      }
    })
    const thread = await manager.startSession({ cwd: '/repo' })
    processes[0].close(1)

    await manager.startTurn({ threadId: thread.id, text: 'Continue.' })

    expect(processes).toHaveLength(2)
    expect(processes[1].received.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'turn/start'
    ])
    manager.dispose()
    expect(processes[1].killed).toBe(true)
  })

  it('sends WSL-native cwd values to the app-server process', async () => {
    const process = createScriptedProcess()
    const manager = new CodexSideQuestManager({
      wslDistro: 'Ubuntu',
      processFactory: () => process.asProcess()
    })

    await manager.startSession({ cwd: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo' })

    const request = process.received.find((message) => message.method === 'thread/start')
    expect(request?.params).toMatchObject({ cwd: '/home/ada/repo' })
    manager.dispose()
  })
})
