import { homedir } from 'node:os'
import type { StructuredAgentRuntimeRegistration } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { resolveTraexReadLaunch, traexPermissionSettings } from './traex-launch-resolution'
import { TraexAppServerConnection } from './traex-app-server-connection'
import { traexRecord, traexText, traexThreadResponseSchema } from './traex-protocol'

export function createTraexTextGeneration(
  context: Parameters<StructuredAgentRuntimeRegistration['createAdapter']>[0]
) {
  const pending = new Map<AbortController, Promise<string | null>>()
  const generate: NonNullable<StructuredAgentSessionAdapter['generateText']> = (input) => {
    const controller = new AbortController()
    const work = (async () => {
      if (input.shouldExecute?.() === false) {
        return null
      }
      const cwd = homedir()
      const launch = await resolveTraexReadLaunch(context, input.accountHome, cwd, {
        signal: controller.signal
      })
      let threadId: string | undefined
      let text = ''
      const completion = Promise.withResolvers<string>()
      void completion.promise.catch(() => {})
      return runAgentModelCatalogSession(
        () =>
          new TraexAppServerConnection(launch, {
            onNotification: (method, value) => {
              const params = traexRecord(value)
              if (params.threadId !== threadId) {
                return
              }
              if (input.shouldExecute?.() === false) {
                controller.abort()
                return
              }
              if (method === 'item/agentMessage/delta') {
                text = (text + (traexText(params.delta) ?? '')).slice(0, 16_384)
              } else if (
                method === 'item/completed' &&
                traexRecord(params.item).type === 'agentMessage'
              ) {
                text = (traexText(traexRecord(params.item).text) ?? text).slice(0, 16_384)
              } else if (method === 'turn/completed') {
                if (traexRecord(params.turn).status === 'completed') {
                  completion.resolve(text)
                } else {
                  completion.reject(new Error('TRAE CLI text generation did not complete'))
                }
              }
            },
            onExit: (error, expected) => {
              if (!expected) {
                completion.reject(error)
              }
            }
          }),
        async (connection) => {
          await connection.initialize()
          if (input.shouldExecute?.() === false) {
            return null
          }
          const opened = traexThreadResponseSchema.parse(
            await connection.request('thread/start', {
              cwd,
              ephemeral: true,
              ...traexPermissionSettings('ask')
            })
          )
          threadId = opened.thread.id
          await connection.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: input.prompt }]
          })
          return await completion.promise
        },
        { label: 'trae', signal: controller.signal, timeoutMs: 30_000 }
      )
    })()
    pending.set(controller, work)
    void work.finally(() => pending.delete(controller)).catch(() => {})
    return work
  }
  const stop = () => pending.forEach((_work, controller) => controller.abort())
  return {
    generate,
    stop,
    close: async () => {
      stop()
      await Promise.allSettled(pending.values())
    }
  }
}
