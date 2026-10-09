import { z } from 'zod'
import type {
  ScriptedAgentChild,
  ScriptedAgentChildFactory
} from '../runtime/structured-agent-scripted-child.test-fixture'
import { FakeAcpChild, GROK_CONFIG_OPTIONS } from './acp-structured-adapter.test-support'
import type { FakeFrame } from './acp-scripted-agent.test-support'
import type { AcpLaunchSpec } from './acp-launch-specs'

const promptParams = z.object({
  sessionId: z.string(),
  prompt: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  _meta: z.object({ promptId: z.string() }).optional()
})
const loadParams = z.object({ sessionId: z.string() })
const configParams = z.object({ configId: z.string(), value: z.string() })

export function acpScriptedChild(agent: AcpLaunchSpec['agent']): ScriptedAgentChildFactory {
  return () => {
    let current: FakeAcpChild | undefined
    let handshake: (() => void) | undefined
    let released = false
    let opened = 0
    let reopened = 0
    let closed = 0
    const texts: string[] = []
    const fixture: ScriptedAgentChild = {
      holdHandshakes: true,
      completeTurns: true,
      deps: {
        resolveEnvironment: async () => ({ PATH: '' }),
        acpLaunchCommand: {
          resolveCommand: () => 'scripted-acp-agent',
          probeVersion: async () => true
        },
        readProcessStartTime: async () => 1_700_000_000_000 + opened,
        openAcpConnection: (launch, options) => {
          opened += 1
          handshake = undefined
          released = false
          const child = new FakeAcpChild(launch, options)
          current = child
          let sessionId = `${agent}-scripted-session`
          let running: FakeFrame | undefined
          let configOptions = GROK_CONFIG_OPTIONS.map((option) => ({ ...option }))
          const script = child.agent
          script.on('initialize', (frame) =>
            script.reply(frame, {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true }
            })
          )
          const start = (frame: FakeFrame, resumes: boolean): void => {
            if (resumes) {
              reopened += 1
              sessionId = loadParams.parse(frame.params).sessionId
            }
            const answer = () => {
              if (child.closed || child.exited) {
                return
              }
              script.reply(frame, { ...(!resumes ? { sessionId } : {}), configOptions })
            }
            if (fixture.holdHandshakes && !released) {
              handshake = answer
            } else {
              answer()
            }
          }
          script.on('session/new', (frame) => start(frame, false))
          script.on('session/load', (frame) => start(frame, true))
          script.on('session/set_config_option', (frame) => {
            const { configId, value } = configParams.parse(frame.params)
            configOptions = configOptions.map((option) =>
              option.id === configId ? { ...option, currentValue: value } : option
            )
            script.reply(frame, { configOptions })
          })
          script.on('session/set_model', (frame) => script.reply(frame, {}))
          // Grok's subagent-stop probe: the handler refuses the missing id, so stops are offered.
          script.on('_x.ai/subagent/cancel', (frame) =>
            script.fail(
              frame,
              -32602,
              'Invalid params',
              'invalid params: missing field `subagentId`'
            )
          )
          script.on('session/prompt', (frame) => {
            const params = promptParams.parse(frame.params)
            texts.push(params.prompt.map((block) => block.text ?? '').join(''))
            running = frame
            script.notify('session/update', {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Scripted response' }
              },
              ...(params._meta ? { _meta: params._meta } : {})
            })
            if (fixture.completeTurns) {
              script.reply(frame, { stopReason: 'end_turn' })
              running = undefined
            }
          })
          script.on('session/cancel', () => {
            if (running) {
              script.reply(running, { stopReason: 'cancelled' })
            }
            running = undefined
          })
          const prove = child.proveClose
          child.proveClose = async () => {
            if (!child.exited) {
              closed += 1
            }
            return prove()
          }
          return child
        }
      },
      releaseHandshake: () => {
        released = true
        handshake?.()
        handshake = undefined
      },
      failHandshake: (message) => {
        if (!current) {
          throw new Error('no scripted ACP child')
        }
        current.stderr = message
        current.exit()
        handshake = undefined
      },
      prompts: () => texts,
      spawns: () => opened,
      resumes: () => reopened,
      closes: () => closed
    }
    return fixture
  }
}
