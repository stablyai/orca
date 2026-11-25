import { z } from 'zod'
import { RelayRefusal } from '../bots/tool-relay/bot-tool-relay-requests'
import type { BotToolRequestBinding } from '../bots/tool-relay/bot-tool-relay-grants'
import type { SpcRead } from './spc-terminal-result'

const startsWorkflow = new Set([
  'import_curseforge',
  'import_url',
  'import_netdisk',
  'import_uploaded_archive',
  'build',
  'retest',
  'diagnose_test',
  'schedule_publish',
  'schedule_create_spl'
])

const ToolCall = z.looseObject({
  method: z.literal('tools/call'),
  params: z.looseObject({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown())
  })
})

export function bindSpcMcpRequest(body: Buffer, bind: (requestId: string) => string): Buffer {
  let value: unknown
  try {
    value = JSON.parse(body.toString())
  } catch {
    return body
  }
  let changed = false
  const bindCall = (entry: unknown) => {
    const parsed = ToolCall.safeParse(entry)
    if (!parsed.success || !startsWorkflow.has(parsed.data.params.name)) {
      return entry
    }
    const args = parsed.data.params.arguments
    const requestId = z.string().min(1).max(128).safeParse(args.request_id)
    if (!requestId.success) {
      throw new RelayRefusal(400, 'SPC workflow requests need a stable request_id.')
    }
    args.correlation_id = bind(requestId.data)
    changed = true
    return parsed.data
  }
  const bound = Array.isArray(value) ? value.map(bindCall) : bindCall(value)
  return changed ? Buffer.from(JSON.stringify(bound)) : body
}

export function spcRequestBinding(input: {
  url: string
  account: () => string | null
  handlesBot: (botId: string) => boolean
  bind: (account: string, botId: string, sessionId: string, requestId: string) => string
}): BotToolRequestBinding {
  return {
    accountForBot: (botId) => (input.handlesBot(botId) ? input.account() : null),
    bind: (url, grant, body) => {
      if (url !== input.url || (!grant.account && !input.handlesBot(grant.owner))) {
        return body
      }
      return bindSpcMcpRequest(body, (requestId) => {
        if (
          !grant.account ||
          !grant.sessionId ||
          !input.handlesBot(grant.owner) ||
          grant.account !== input.account()
        ) {
          throw new RelayRefusal(403, 'Open an Orca conversation to start this SPC workflow.')
        }
        return input.bind(grant.account, grant.owner, grant.sessionId, requestId)
      })
    }
  }
}

const Answer = z.object({
  id: z.literal(1),
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.object({ success: z.literal(true), data: z.unknown() })
  })
})

export function spcMcpReader(
  send: (body: string, signal: AbortSignal) => Promise<Response>
): SpcRead {
  return async (name, args) => {
    const response = await send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      }),
      AbortSignal.timeout(20_000)
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`SPC verification request failed (${response.status}).`)
    }
    const parsed = Answer.safeParse(await response.json())
    if (!parsed.success || parsed.data.result.isError) {
      throw new Error('SPC did not return a successful task readback.')
    }
    return parsed.data.result.structuredContent.data
  }
}
