import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

function actor() {
  const paneKey = process.env.ORCA_PANE_KEY
  const launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
  if (!paneKey || !launchToken) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Run this command inside an Orca canvas agent with managed hooks enabled.'
    )
  }
  return { paneKey, launchToken }
}
export const CANVAS_HANDLERS: Record<string, CommandHandler> = {
  'canvas peers': async ({ client, json }) =>
    printResult(await client.call('canvas.peers', actor()), json, (value) =>
      JSON.stringify(value, null, 2)
    ),
  'canvas send': async ({ client, flags, json }) => {
    const result = await client.call('canvas.send', {
      ...actor(),
      canvasId: getRequiredStringFlag(flags, 'canvas'),
      to: getRequiredStringFlag(flags, 'to'),
      body: getRequiredStringFlag(flags, 'body'),
      kind: getOptionalStringFlag(flags, 'kind'),
      replyTo: getOptionalStringFlag(flags, 'reply-to'),
      requestId: getOptionalStringFlag(flags, 'request-id') ?? randomUUID()
    })
    printResult(result, json, (value) => JSON.stringify(value, null, 2))
  },
  'canvas inbox': async ({ client, flags, json }) =>
    printResult(
      await client.call('canvas.inbox', {
        ...actor(),
        canvasId: getRequiredStringFlag(flags, 'canvas')
      }),
      json,
      (value) => JSON.stringify(value, null, 2)
    )
}
