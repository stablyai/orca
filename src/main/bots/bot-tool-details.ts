import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import {
  BotToolInputSchema,
  botToolInputError,
  type BotToolDetails,
  type BotToolInput,
  type BotToolSecretInput,
  type BotToolServer
} from '../../shared/bot-tools'
import { readBotToolsSnapshot } from './bot-tools-file'
import {
  botToolCredentialHeaderNames,
  readBotToolCredential,
  readBotToolOAuth
} from './bot-tool-credentials'

export async function readBotToolDetails(folder: string, name: string): Promise<BotToolDetails> {
  const { servers, version } = await readBotToolsSnapshot(folder)
  const server = servers.find((entry) => entry.name === name)
  if (!server) {
    throw new BotFailureError('toolGone')
  }
  return botToolDetailsOf(folder, server, version)
}

/** `server` for the editor, its saved values masked; `folder` holds its credential. */
export function botToolDetailsOf(
  folder: string,
  server: BotToolServer,
  version: string
): BotToolDetails {
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
    throw new BotFailureError('toolDetailsInvalid')
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
        throw new BotFailureError('toolDestinationChanged')
      }
      value = saved?.[row.key]
      if (value === undefined) {
        throw new BotFailureError('toolSavedValueGone')
      }
    }
    if (value === undefined || (!row.keep && value === '') || (remote && /[\r\n]/.test(value))) {
      throw new BotFailureError('toolValueMissing')
    }
    return [row.key, value]
  })
  const secrets = Object.fromEntries(entries)
  // The editor never sees a sign-in: with no headers it stays, and a new address starts a new one.
  const signIn =
    previous && 'url' in previous && entries.length === 0 ? previous.credential : undefined
  return remote
    ? {
        name: draft.name,
        url: draft.url,
        transport: 'http',
        headers: secrets,
        ...(signIn ? { credential: signIn } : {})
      }
    : { name: draft.name, command: draft.command, args: draft.args, env: secrets }
}

/**
 * A stored tool as an edit starts from: its saved values and the address they're bound to, and a
 * credential id only for Orca's own sign-in, which the edit keeps.
 */
export function withSavedBotToolHeaders(folder: string, server: BotToolServer): BotToolServer {
  if (!('url' in server) || !server.credential) {
    return server
  }
  if (readBotToolOAuth(folder, server.credential)) {
    // Its tokens are Orca's own sign-in; a generic edit keeps the id and changes no values.
    return server
  }
  const { credential, ...rest } = server
  const saved = readBotToolCredential(folder, credential)
  if (saved?.source) {
    // Its headers come from a source Orca fills per call; a generic edit would drop them.
    throw new BotFailureError('toolSourceManaged')
  }
  return saved ? { ...rest, url: saved.url, headers: saved.headers } : rest
}
