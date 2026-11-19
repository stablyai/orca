import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { ClaudeStreamJsonLaunch } from '../../../claude/claude-stream-json-connection'
import type { FakeConnection } from '../../../claude/structured/claude-structured-session-test-support'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createClaudeNamingRuntime,
  writeNativeNamingConversation
} from './structured-claude-naming-test-support'

type Runtime = Awaited<ReturnType<typeof createClaudeNamingRuntime>>
let runtime: Runtime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

type Title = { title: string; while: 'queued' | 'started'; subagent?: true }

/** Answers each send with the frame order Claude Code 2.1.327 emits; `titles` maps prompt text to
 *  the session_title_changed frames its turn carries (a /rename's own, or a hook's sessionTitle). */
function scriptTurns(titles: Record<string, Title[]>) {
  return async (launch: ClaudeStreamJsonLaunch, connection: FakeConnection): Promise<void> => {
    const sessionId = String(launch.options.resume ?? launch.options.sessionId)
    const frame = (message: Record<string, unknown>) =>
      connection.handlers.onMessage?.({ session_id: sessionId, ...message })
    const answer = connection.send
    let launched = false
    connection.send = async (message, beforeDispatch) => {
      await beforeDispatch?.()
      if (!launched) {
        launched = true
        // A relaunched chat replays its saved title before the send is even queued.
        frame({ type: 'system', subtype: 'session_title_changed', title: 'Replayed Title' })
      }
      const uuid = message.uuid
      const turnTitles = titles[promptText(message)] ?? []
      const lifecycle = (state: string) =>
        frame({ type: 'command_lifecycle', command_uuid: uuid, state })
      const title = (when: Title['while']) => {
        for (const entry of turnTitles.filter((candidate) => candidate.while === when)) {
          frame({
            type: 'system',
            subtype: 'session_title_changed',
            title: entry.title,
            ...(entry.subagent ? { parent_tool_use_id: 'toolu_child' } : {})
          })
        }
      }
      frame({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      lifecycle('queued')
      title('queued')
      lifecycle('started')
      title('started')
      await answer(message)
      lifecycle('completed')
      frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }
  }
}

function promptText(message: Record<string, unknown>): string {
  const body = message.message
  const content =
    typeof body === 'object' && body !== null && 'content' in body ? body.content : null
  const last: unknown = Array.isArray(content) ? content.at(-1) : null
  return typeof last === 'object' &&
    last !== null &&
    'text' in last &&
    typeof last.text === 'string'
    ? last.text
    : ''
}

async function startChat(titles: Record<string, Title[]>) {
  const named: (string | undefined)[] = []
  let record = (): AgentSessionRecord | null => null
  runtime = await createClaudeNamingRuntime({
    beforeOpen: scriptTurns(titles),
    onNamed: () => named.push(record()?.conversationName)
  })
  const host = await runtime.install()
  record = () => host.deps.store.getRecord(HOST_TEST_SESSION)
  await writeNativeNamingConversation(runtime.file, runtime.nativeId, runtime.root)
  expect(await runtime.create()).toMatchObject({ ok: true })
  return { runtime, named, record }
}

it.each(['/rename', '/name'])(
  'names the chat from Claude %s without pushing it back',
  async (command) => {
    const chat = await startChat({
      [`${command} 东莞银行Bond补丁项目`]: [{ title: '东莞银行Bond补丁项目', while: 'started' }]
    })
    await chat.runtime.send(`${command} 东莞银行Bond补丁项目`)
    await vi.waitFor(() =>
      expect(chat.record()).toMatchObject({
        conversationName: '东莞银行Bond补丁项目',
        conversationNameSource: 'user'
      })
    )
    expect(chat.named).toEqual(['东莞银行Bond补丁项目'])
    expect(chat.runtime.controls).toEqual([])
  }
)

it('ignores titles outside a started rename send', async () => {
  const chat = await startChat({
    'An ordinary prompt': [{ title: 'Hook Title', while: 'started' }],
    '/rename Wanted': [
      { title: 'Earlier Turn Title', while: 'queued' },
      { title: 'Wanted', while: 'started' },
      { title: 'Subagent Title', while: 'started', subagent: true }
    ],
    '/rename Final': [{ title: 'Final', while: 'started' }]
  })
  await chat.runtime.send('An ordinary prompt')
  await chat.runtime.send('/rename Wanted')
  await vi.waitFor(() => expect(chat.named).toEqual(['Wanted']))
  await chat.runtime.send('/rename Final')
  await vi.waitFor(() => expect(chat.named).toEqual(['Wanted', 'Final']))
  expect(chat.record()?.conversationName).toBe('Final')
  expect(chat.runtime.controls).toEqual([])
})
