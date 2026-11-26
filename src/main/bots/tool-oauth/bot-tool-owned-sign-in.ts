// Which of a bot's tools Orca signs in to: a new address is sorted by what it answers, and a tool
// that has Orca's sign-in is found by name for Connect and its status.
import { hostname } from 'node:os'
import type { BotOwnTool, BotToolServer } from '../../../shared/bot-tools'
import {
  botToolSignInFailureWords,
  type BotToolSignInFailure,
  type BotToolSignInProgress
} from '../../../shared/bot-tool-sign-in'
import { newBotToolCredentialId, readBotToolOAuth } from '../bot-tool-credentials'
import { botOwnTool, readBotToolServers, type BotToolNewCredential } from '../bot-tools-file'
import { addBotTool, type BotToolsHome } from '../bot-tools-host'
import type { RpcCallerIdentity } from '../../runtime/rpc/callers/rpc-caller-identity'
import { discoverBotToolAuth } from './bot-tool-oauth-discovery'
import { BotToolSignInError, discoveryOptions, type BotToolOAuthKey } from './bot-tool-oauth'
import { botToolSignInProgress, connectBotToolSignIn } from './bot-tool-sign-in-flows'

/**
 * A new tool as it should be added: an address that needs a sign-in gets a credential id Orca signs
 * in under (`signIn`, the credential to add with it). One with saved values, or that answers without a sign-in, is added as given.
 * Throws, in the host's words, when the address can't be used.
 */
export async function classifyAddedBotTool(
  server: BotToolServer,
  signal?: AbortSignal
): Promise<{ server: BotToolServer; signIn?: ReadonlyMap<string, BotToolNewCredential> }> {
  const sorted = await sortAddedBotTool(server, signal)
  if ('failure' in sorted) {
    throw new Error(botToolSignInMessage(sorted.failure))
  }
  return sorted
}

/** As `classifyAddedBotTool`, answering why an address can't be used instead of throwing. */
export async function sortAddedBotTool(
  server: BotToolServer,
  signal?: AbortSignal
): Promise<
  | { server: BotToolServer; signIn?: ReadonlyMap<string, BotToolNewCredential> }
  | { failure: 'unsupported' | 'unavailable' }
> {
  if (!('url' in server) || server.credential || Object.keys(server.headers ?? {}).length > 0) {
    return { server }
  }
  const need = await discoverBotToolAuth(server.url, discoveryOptions(signal))
  if (need.kind === 'none') {
    return { server }
  }
  if (need.kind === 'oauth') {
    const id = newBotToolCredentialId()
    // The tools file and the signed-out sign-in are written in one transaction.
    return {
      server: { ...server, credential: id },
      signIn: new Map([[id, { url: server.url, signIn: true }]])
    }
  }
  return { failure: need.kind }
}

/** Adds `given` to the bot, as Orca's own sign-in tool when its address needs a sign-in. */
export async function addSortedBotTool(
  cli: BotToolsHome,
  given: BotToolServer,
  signal?: AbortSignal
): Promise<BotOwnTool> {
  const { server, signIn } = await classifyAddedBotTool(given, signal)
  await addBotTool(cli, server, signIn)
  return botOwnTool(server, cli.folder)
}

/** The tool's sign-in, when Orca signs in to it; null for any other tool. */
export async function ownedSignInKey(
  folder: string,
  name: string
): Promise<BotToolOAuthKey | null> {
  const server = (await readBotToolServers(folder)).find((entry) => entry.name === name)
  if (!server || !('url' in server) || !server.credential) {
    return null
  }
  return readBotToolOAuth(folder, server.credential)
    ? { folder, credentialId: server.credential }
    : null
}

/** The host's words for a failure, for the CLI and any client that shows the host's message. */
export function botToolSignInMessage(code: BotToolSignInFailure): string {
  return botToolSignInFailureWords(code, hostname())
}

/** What an Orca from before `bots.tools.signIn.*` is told for a tool Orca signs in to: no CLI sign-in instead. */
export const BOT_TOOL_SIGN_IN_NEEDS_UPDATE = 'Update Orca on this device to sign in to this app.'

/**
 * Connect for a tool Orca signs in to; null for any other tool. The browser opens on this computer,
 * so only a caller here (its desktop window or CLI) can use it; another device signs in through
 * `bots.tools.signIn.*`, so one calling this is an older Orca.
 */
export async function connectOwnedBotTool(
  folder: string,
  name: string,
  { caller }: { caller?: RpcCallerIdentity }
): Promise<{ attemptId: string; authorizationOrigin: string } | null> {
  const key = await ownedSignInKey(folder, name)
  if (!key) {
    return null
  }
  if (caller?.kind !== 'local-cli' && caller?.kind !== 'desktop') {
    throw new Error(BOT_TOOL_SIGN_IN_NEEDS_UPDATE)
  }
  try {
    return await connectBotToolSignIn(key)
  } catch (error) {
    throw error instanceof BotToolSignInError ? new Error(botToolSignInMessage(error.code)) : error
  }
}

// The legacy watch's words for a Connect Orca runs itself, so either kind of tool reads the same.
const LEGACY_STATUS = { idle: 'none', waiting: 'pending', done: 'done', failed: 'failed' } as const

/** How a tool Orca signs in to stands, in the legacy words and in full; null for any other tool. */
export async function ownedBotToolSignInStatus(
  folder: string,
  name: string
): Promise<{ status: string; progress: BotToolSignInProgress } | null> {
  const key = await ownedSignInKey(folder, name)
  if (!key) {
    return null
  }
  const progress = botToolSignInProgress(key)
  return { status: LEGACY_STATUS[progress.state], progress }
}
