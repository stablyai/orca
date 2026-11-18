import {
  BotToolInputSchema,
  botToolInputError,
  type BotToolDetails,
  type BotToolInput,
  type BotToolSecretInput,
  type BotToolServer
} from '../../shared/bot-tools'
import { readBotToolsSnapshot } from './bot-tools-file'
import { botToolCredentialHeaderNames } from './bot-tool-credentials'

export async function readBotToolDetails(folder: string, name: string): Promise<BotToolDetails> {
  const { servers, version } = await readBotToolsSnapshot(folder)
  const server = servers.find((entry) => entry.name === name)
  if (!server) {
    throw new Error('This bot no longer has that tool.')
  }
  const masked = (values: Record<string, string> | undefined) =>
    Object.keys(values ?? {}).map((key) => ({ key, configured: true }))
  return {
    version,
    server:
      'url' in server
        ? {
            name: server.name,
            url: server.url,
            transport: 'http',
            headers: server.credential
              ? botToolCredentialHeaderNames(folder, server.credential).map((key) => ({
                  key,
                  configured: true
                }))
              : masked(server.headers)
          }
        : { name: server.name, command: server.command, args: server.args, env: masked(server.env) }
  }
}

export function resolveBotToolInput(
  input: BotToolInput,
  previous?: BotToolServer,
  platform: NodeJS.Platform = process.platform
): BotToolServer {
  const result = BotToolInputSchema.safeParse(input)
  if (!result.success) {
    throw new Error('Tool details are invalid. Check the name, URL or executable and values.')
  }
  const draft = result.data
  const remote = 'url' in draft
  const destinationUnchanged =
    previous &&
    (remote
      ? 'url' in previous && new URL(previous.url).origin === new URL(draft.url).origin
      : 'command' in previous && previous.command === draft.command)
  const saved =
    previous &&
    (remote
      ? 'url' in previous
        ? previous.headers
        : undefined
      : 'command' in previous
        ? previous.env
        : undefined)
  const rows = remote ? draft.headers : draft.env
  const validationError = botToolInputError(draft, platform)
  if (validationError) {
    throw new Error(validationError)
  }
  const entries = rows.map((row: BotToolSecretInput): [string, string] => {
    let value = row.value
    if (row.keep) {
      if (!destinationUnchanged) {
        throw new Error(
          'The credential destination changed. Re-enter saved values or remove their rows.'
        )
      }
      value = saved?.[row.key]
      if (value === undefined) {
        throw new Error('That saved value is no longer available. Re-enter it or remove its row.')
      }
    }
    if (value === undefined || (!row.keep && value === '') || (remote && /[\r\n]/.test(value))) {
      throw new Error('Enter a value for each row, or remove the row.')
    }
    return [row.key, value]
  })
  const secrets = Object.fromEntries(entries)
  return remote
    ? { name: draft.name, url: draft.url, transport: 'http', headers: secrets }
    : { name: draft.name, command: draft.command, args: draft.args, env: secrets }
}
