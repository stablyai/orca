import { PassThrough } from 'node:stream'
import { expect } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { createAcpAgentConnection, type AcpAgentConnection } from './acp-agent-connection'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'

const STARTUP_BODY = 'whole final startup output'
const STARTUP_ITEM =
  'legacy:grok:session-timeline:item%3Ap%3Aprovider-session-1%3Aprovider-session-1%2Ftool%253Astartup-tool'

export async function startupReceiveRig(
  options: { rootOnClose?: boolean; identityFails?: boolean; sourceFails?: boolean } = {}
) {
  const { openAcpAdapterRig, GROK_CONFIG_OPTIONS } =
    await import('./acp-structured-adapter.test-support')
  const inputCompletions: (Error | undefined)[] = []
  const clock = { now: 5_000 }
  const children: ReturnType<typeof createFakePipedChild>[] = []
  const agents: AcpScriptedAgent[] = []
  const connections: AcpAgentConnection[] = []
  const requested = Promise.withResolvers<Parameters<AcpScriptedAgent['reply']>[0]>()
  const notify = (complete: boolean) =>
    agents[0].notify('session/update', {
      sessionId: 'provider-session-1',
      update: complete
        ? {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'startup-tool',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: STARTUP_BODY } }]
          }
        : {
            sessionUpdate: 'tool_call',
            toolCallId: 'startup-tool',
            title: 'echo complete',
            kind: 'execute',
            status: 'in_progress'
          }
    })
  const f = await openAcpAdapterRig({
    deps: {
      now: () => clock.now,
      readProcessStartTime: async () => {
        if (options.identityFails) {
          notify(false)
          throw new Error('identity read failed')
        }
        return 1
      },
      connect: (launch, handlers) => {
        const agent = new AcpScriptedAgent()
        const child = Object.assign(createFakePipedChild(9_999_999), {
          stdin: agent.stdin,
          stdout: agent.stdout,
          stderr: new PassThrough()
        })
        let newRequest: Parameters<typeof agent.reply>[0] | undefined
        agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
        agent.on('session/new', (frame) => {
          if (children.length === 1) {
            newRequest = frame
            requested.resolve(frame)
          } else {
            agent.reply(frame, {
              sessionId: 'replacement-session',
              configOptions: GROK_CONFIG_OPTIONS
            })
          }
        })
        for (const method of ['_x.ai/subagent/cancel', '_x.ai/task/kill']) {
          agent.on(method, (frame) => agent.fail(frame, -32602, 'Invalid params', 'missing field'))
        }
        agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
        child.stdin.once('finish', () => {
          if (children[0] === child) {
            if (newRequest) {
              agent.reply(newRequest, {
                sessionId: 'provider-session-1',
                configOptions: GROK_CONFIG_OPTIONS
              })
            }
            notify(true)
            if (options.sourceFails) {
              child.stdout.emit('error', new Error('startup source failed'))
            }
          }
          if (options.rootOnClose !== false || children[0] !== child) {
            child.emit('exit', 0, null)
          }
          child.stdout.end()
          child.stderr.end()
        })
        const connection = createAcpAgentConnection(
          launch,
          {
            ...handlers,
            onInputComplete: (error) => {
              inputCompletions.push(error)
              clock.now = 9_000
              handlers.onInputComplete?.(error)
            }
          },
          () => child
        )
        children.push(child)
        agents.push(agent)
        connections.push(connection)
        return connection
      }
    }
  })
  const receivedAfter = f.rig.journal.cursor()
  const saved = async (reopen = true) => {
    await expect(f.rig.eventSink.written?.()).resolves.toEqual({ ok: true })
    const reopened = reopen ? await f.rig.reopenJournal() : f.rig.journal
    const replay = reopened.readSince(receivedAfter)
    if (!replay.ok) {
      throw new Error('received startup output is not replayable')
    }
    const updates = replay.rows.flatMap((row) =>
      row.kind === 'item' && row.body.kind === 'tool-call'
        ? [{ itemId: row.itemId, state: row.body.state }]
        : []
    )
    expect(updates).toEqual([
      { itemId: STARTUP_ITEM, state: 'running' },
      { itemId: STARTUP_ITEM, state: 'completed' }
    ])
    const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
    expect(tools.map((row) => row.itemId)).toEqual([STARTUP_ITEM])
    expect(tools[0].body).toMatchObject({
      callId: 'startup-tool',
      state: 'completed',
      output: {
        head: STARTUP_BODY,
        byteLength: 26,
        digest: '853cbca8ac59bb40c8f14dbc62a6bc03637a9c60de9406383d668eeb7ef95edd',
        truncated: false
      }
    })
    return reopened
  }
  return { f, children, agents, connections, inputCompletions, notify, requested, saved }
}
