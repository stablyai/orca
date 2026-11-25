import { automationWebhookTrigger } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import { hookIdOfRule, WEBHOOK_HOOK_ID_PATTERN } from '../../shared/connector-webhook-contract'
import { readBotToolServers } from '../bots/bot-tools-file'
import type { BotThreadPosts } from '../bots/bot-thread-posts'
import { botToolRelay } from '../bots/tool-relay/bot-tool-relay'
import { setRelayRequestBinding } from '../bots/tool-relay/bot-tool-relay-grants'
import { getMainHttpClient } from '../network/http-client'
import type { WebhookCallRouter } from '../webhooks/webhook-call-outcomes'
import { spcMcpReader, spcRequestBinding } from './spc-mcp'
import { readSpcTerminalResult, SpcTerminalNotice } from './spc-terminal-result'

export function installSpcHost(deps: {
  account: () => string | null
  automations: () => readonly Automation[]
  botFolder: (botId: string) => string | null
  posts: BotThreadPosts
}): { route: WebhookCallRouter; stop: () => void } | null {
  const hookId = process.env.ORCA_SPC_WEBHOOK_ID
  const endpoint = process.env.ORCA_SPC_MCP_URL
  if (!hookId && !endpoint) {
    return null
  }
  if (!hookId || !WEBHOOK_HOOK_ID_PATTERN.test(hookId)) {
    console.warn('[spc] Set ORCA_SPC_WEBHOOK_ID to the SPC webhook ID.')
    return null
  }
  const url = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : null
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    console.warn('[spc] Set ORCA_SPC_MCP_URL to the HTTPS SPC MCP endpoint.')
    return {
      stop: () => {},
      route: async (id) => {
        if (id === hookId) {
          throw new Error('The SPC verification endpoint is not configured.')
        }
        return null
      }
    }
  }
  const botOfHook = () =>
    deps.automations().find((entry) => {
      const rule = automationWebhookTrigger(entry)
      return rule && hookIdOfRule(rule.id) === hookId
    })?.bot?.botId
  setRelayRequestBinding(
    spcRequestBinding({
      url: url.href,
      account: deps.account,
      handlesBot: (botId) => botOfHook() === botId,
      bind: (account, botId, sessionId, requestId) =>
        deps.posts.bind(account, botId, sessionId, requestId)
    })
  )
  return {
    stop: () => setRelayRequestBinding(null),
    route: async (id, call, incomplete) => {
      if (id !== hookId) {
        return null
      }
      const notice = SpcTerminalNotice.safeParse(call.body)
      if (incomplete || !notice.success) {
        return { kind: 'handled', reason: 'spc_invalid_notification' }
      }
      const account = deps.account()
      const botId = botOfHook()
      const folder = botId && deps.botFolder(botId)
      if (!account || !botId || !folder) {
        throw new Error('The SPC notification host has no active bot credential.')
      }
      const tools = (await readBotToolServers(folder)).flatMap((tool) =>
        'url' in tool && tool.url === url.href && tool.credential ? [tool.credential] : []
      )
      const credentialId = tools.length === 1 ? tools[0] : undefined
      if (!credentialId) {
        throw new Error(
          'The SPC notification host needs one credential for its configured endpoint.'
        )
      }
      const read = spcMcpReader(async (body, signal) => {
        if (deps.account() !== account || botOfHook() !== botId) {
          throw new Error('The SPC notification host changed accounts or bots.')
        }
        const credential = { host: 'local', folder, credentialId, signal } as const
        const send = async (rejected?: string) => {
          const answer = await botToolRelay.credential({ ...credential, rejected })
          if (answer.kind !== 'ready' || answer.url !== url.href || deps.account() !== account) {
            throw new Error('The SPC verification credential is unavailable.')
          }
          const response = await getMainHttpClient().fetch(url.href, {
            method: 'POST',
            headers: {
              ...answer.headers,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream'
            },
            body,
            redirect: 'error',
            signal
          })
          return { response, bearer: answer.bearer }
        }
        const { response, bearer } = await send()
        if (response.status !== 401 || !bearer) {
          return response
        }
        await response.body?.cancel()
        return (await send(bearer)).response
      })
      const result = await readSpcTerminalResult(notice.data, read)
      if (result.kind === 'ignored') {
        return { kind: 'handled', reason: result.reason }
      }
      if (botOfHook() !== botId) {
        throw new Error('The SPC notification hook changed bots.')
      }
      const receipt = await deps.posts.postToThread(account, {
        botId,
        deliveryId: result.deliveryId,
        correlationId: result.correlationId,
        text: result.text,
        wake: false
      })
      return { kind: 'handled', reason: `spc_delivered_to_${receipt.destination}`, completed: true }
    }
  }
}
