import { describe, expect, it } from 'vitest'
import { AcpScriptedAgent } from '../acp/process/testing/acp-scripted-agent.test-support'
import { AcpSessionRuntime } from '../acp/protocol/acp-session-runtime'
import { AcpTimelineTranslator } from '../acp/timeline/acp-timeline-translator'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { AcpStructuredOptions } from '../acp/options/acp-structured-options'

const sessionId = '01a20b05-73eb-7922-b54f-187e99bdaa84'
const workspace = { cwd: '/workspace', mcpServers: [] }
const model = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'muse-wonder-1.0',
  options: [{ value: 'muse-wonder-1.0', name: 'muse-wonder-1.0' }]
}

function museSession() {
  const spec = acpLaunchSpecFor('muse')
  if (!spec) {
    throw new Error('Muse ACP is unavailable')
  }
  const agent = new AcpScriptedAgent()
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, {
    clientCapabilities: spec.dialect.clientCapabilities
  })
  agent.on('initialize', (frame) =>
    agent.reply(frame, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [{ id: 'muse-login', name: 'Log in to Muse' }]
    })
  )
  return { agent, runtime, spec }
}

describe('Muse ACP session', () => {
  it('maps the loaded model, streamed answer and tool output, and permits a prompt after cancellation', async () => {
    const { agent, runtime, spec } = museSession()
    const timeline = new AcpTimelineTranslator({ sessionId, dialect: spec.dialect })
    const events: ReturnType<typeof timeline.sessionEvent> = []
    runtime.subscribe((event) => events.push(...timeline.sessionEvent(event, 2)))
    agent.on('session/load', (frame) => agent.reply(frame, { configOptions: [model] }))
    try {
      const session = await runtime.start({ ...workspace, sessionId })
      const options = new AcpStructuredOptions(spec.dialect)
      options.adoptSession(session.response, 'loaded')
      expect(session.kind).toBe('load')
      expect(options.read().current.model).toBe('muse-wonder-1.0')

      timeline.openPrompt('cancelled-prompt', 1)
      agent.on('session/prompt', (frame) =>
        agent.on('session/cancel', () => agent.reply(frame, { stopReason: 'cancelled' }))
      )
      const cancelled = runtime.prompt([{ type: 'text', text: 'Wait.' }])
      await runtime.cancel()
      const result = await cancelled
      expect(result.stopReason).toBe('cancelled')
      timeline.promptResult('cancelled-prompt', result, 3, true)

      timeline.openPrompt('follow-up', 4)
      agent.on('session/prompt', (frame) => {
        const update = (update: unknown) => agent.notify('session/update', { sessionId, update })
        update({ sessionUpdate: 'tool_call', toolCallId: 'probe', title: 'Read', kind: 'read' })
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'probe',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'read result' } }]
        })
        for (const text of ['Muse', ' reply']) {
          update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'reply-1',
            content: { type: 'text', text }
          })
        }
        agent.reply(frame, { stopReason: 'end_turn' })
      })
      await expect(runtime.prompt([{ type: 'text', text: 'Follow up.' }])).resolves.toMatchObject({
        stopReason: 'end_turn'
      })
      expect(
        events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : [])).join('')
      ).toBe('Muse reply')
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'item.close',
          body: expect.objectContaining({
            kind: 'tool-call',
            state: 'completed',
            output: expect.objectContaining({ head: 'read result' })
          })
        })
      )
    } finally {
      runtime.close()
      timeline.dispose()
      agent.close()
    }
  })

  it('reports the observed sign-in refusal without starting a device login', async () => {
    const { agent, runtime } = museSession()
    agent.on('session/new', (frame) =>
      agent.fail(frame, -32000, 'log in to Muse before opening a session')
    )
    try {
      await expect(runtime.start(workspace)).rejects.toMatchObject({
        message: 'log in to Muse before opening a session',
        authMethods: [{ id: 'muse-login', name: 'Log in to Muse' }]
      })
      expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new'])
    } finally {
      runtime.close()
      agent.close()
    }
  })
})
