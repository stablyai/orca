import { pathToFileURL } from 'node:url'

export default async function (pi) {
  pi.registerProvider('orca-wake-test', {
    baseUrl: process.env.ORCA_PI_WAKE_BASE_URL,
    apiKey: 'local-test-only',
    api: 'openai-completions',
    models: [
      {
        id: 'wake-test',
        name: 'Wake test',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 256
      }
    ]
  })
  const helper = process.env.ORCA_PI_PARENT_WAKE_MODULE
  const wake = helper ? (await import(pathToFileURL(helper).href)).createParentWake(pi) : undefined
  pi.on('session_start', (_event, ctx) => wake?.bindSession(ctx))
  pi.on('agent_start', () => wake?.agentStarted())
  let scheduled = false
  pi.on('agent_end', () => {
    if (scheduled) {
      return
    }
    scheduled = true
    setTimeout(() => {
      const notice = {
        customType: 'subagent-notify',
        content: 'BACKGROUND_RESULT: review complete, no issues.',
        display: true
      }
      if (wake) {
        wake.sendMessage(notice, { triggerTurn: true })
      } else {
        pi.sendMessage(notice, { triggerTurn: false })
        pi.sendUserMessage('Inspect subagent updates above and resume the authorized task.', {
          deliverAs: 'steer'
        })
      }
    }, 200)
  })
}
