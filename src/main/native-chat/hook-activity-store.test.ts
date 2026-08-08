import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { mergeNativeChatHookActivity, NativeChatHookActivityStore } from './hook-activity-store'

let directory: string | null = null

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = null
  }
})

describe('NativeChatHookActivityStore', () => {
  it('persists one chronological operation while PreToolUse becomes PostToolUse', async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-hook-activity-'))
    const store = new NativeChatHookActivityStore()
    store.setRoot(directory)
    const received: string[] = []
    store.subscribe('codex', 'session-1', (message) => received.push(message.id))

    store.ingest(event('PreToolUse', 100, { input: { cmd: 'pwd' } }))
    store.ingest(event('PostToolUse', 200, { output: '/repo' }))

    const replay = store.read('codex', 'session-1')
    expect(received).toEqual(['hook:tool-1', 'hook:tool-1'])
    expect(replay).toEqual([
      expect.objectContaining({
        id: 'hook:tool-1',
        timestamp: 100,
        blocks: [
          { type: 'tool-call', name: 'exec_command', input: { cmd: 'pwd' } },
          { type: 'tool-result', output: '/repo' }
        ]
      })
    ])
  })

  it('completes an operation after store restart without losing its input or start time', async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-hook-activity-'))
    const beforeRestart = new NativeChatHookActivityStore()
    beforeRestart.setRoot(directory)
    beforeRestart.ingest(event('PreToolUse', 100, { input: { cmd: 'pwd' } }))

    const afterRestart = new NativeChatHookActivityStore()
    afterRestart.setRoot(directory)
    afterRestart.ingest(event('PostToolUseFailure', 200, { output: 'failed', isError: true }))

    expect(afterRestart.read('codex', 'session-1')).toEqual([
      expect.objectContaining({
        timestamp: 100,
        blocks: [
          { type: 'tool-call', name: 'exec_command', input: { cmd: 'pwd' } },
          { type: 'tool-result', output: 'failed', isError: true }
        ]
      })
    ])
  })

  it('merges hook operations into the transcript window without reviving older activity', () => {
    const transcript = [message('user', 100), message('assistant', 300)]
    const activity = [toolMessage('old', 50), toolMessage('current', 200)]
    expect(mergeNativeChatHookActivity(transcript, activity).map((entry) => entry.id)).toEqual([
      'user',
      'hook:current',
      'assistant'
    ])
  })

  it('keeps in-flight activity newer than the latest transcript only for the live tail', () => {
    const transcript = [message('user', 100)]
    const activity = [toolMessage('current', 200)]

    expect(mergeNativeChatHookActivity(transcript, activity)).toEqual(transcript)
    expect(
      mergeNativeChatHookActivity(transcript, activity, true).map((entry) => entry.id)
    ).toEqual(['user', 'hook:current'])
  })

  it('ignores non-Codex and non-tool lifecycle hooks', () => {
    const store = new NativeChatHookActivityStore()
    expect(store.ingest(event('Stop', 100, { output: 'done' }))).toBeNull()
    expect(
      store.ingest({
        ...event('PreToolUse', 100, { input: { cmd: 'pwd' } }),
        payload: {
          ...event('PreToolUse', 100, { input: { cmd: 'pwd' } }).payload,
          agentType: 'claude'
        }
      })
    ).toBeNull()
  })
})

function event(
  hookEventName: string,
  receivedAt: number,
  toolActivity: NonNullable<AgentHookEventPayload['toolActivity']>
): AgentHookEventPayload & { receivedAt: number } {
  return {
    paneKey: 'tab:pane',
    connectionId: null,
    hookEventName,
    toolUseId: 'tool-1',
    toolActivity,
    providerSession: { key: 'session_id', id: 'session-1' },
    payload: {
      state: 'working',
      prompt: '',
      agentType: 'codex',
      toolName: 'exec_command'
    },
    receivedAt
  }
}

function message(id: string, timestamp: number) {
  return {
    id,
    role: id === 'user' ? ('user' as const) : ('assistant' as const),
    blocks: [{ type: 'text' as const, text: id }],
    timestamp,
    source: 'transcript' as const
  }
}

function toolMessage(id: string, timestamp: number) {
  return {
    id: `hook:${id}`,
    role: 'tool' as const,
    blocks: [{ type: 'tool-call' as const, name: 'exec_command', input: {} }],
    timestamp,
    source: 'hook' as const
  }
}
