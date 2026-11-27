// What the relay asks for each call: the real address and headers for one bot credential, from saved
// headers, a source Orca fills (a hub's key), or Orca's own sign-in, which it refreshes here.
import { createHash } from 'node:crypto'
import { botToolCredentialsReader, type BotToolCredential } from '../bot-tool-credentials'
import { botToolUrlOf } from '../bot-tools-path'
import type { BotToolOAuthKey } from './bot-tool-oauth'
import {
  botToolAccessToken,
  botToolSignInState,
  refreshBotToolAccessToken
} from './bot-tool-oauth-tokens'

export type BotToolCredentialRequest = {
  /** The runtime host whose store holds it; v1 has only this computer's, `local`. */
  host: 'local'
  folder: string
  credentialId: string
  /**
   * The bearer the app just refused with a 401, from an earlier `ready` answer: asks for one
   * refresh, shared by every call refused with the same token. Never set for a 403.
   */
  rejected?: string
  /** The agent hung up or the call was cut: stop waiting (a shared refresh keeps running). */
  signal: AbortSignal
}

export type BotToolCredentialAnswer =
  | {
      kind: 'ready'
      url: string
      headers: Record<string, string>
      /**
       * Which upstream session this call belongs to. A sign-in's stays the same across token
       * refreshes and changes when it's replaced or signed out; saved headers change it on any edit.
       */
      session: string
      /** Orca's sign-in only: the token in `headers`, to pass back as `rejected` after a 401. */
      bearer?: string
    }
  /** A tool Orca signs in to with no sign-in a call can use: answer "sign in", never a 401. */
  | { kind: 'sign-in-needed' }
  /** Its key isn't set up here, or the app's token server didn't answer: try again later. */
  | { kind: 'unavailable' }
  /** The bot has no such credential. */
  | { kind: 'missing' }

export type BotToolCredentialSource = (
  request: BotToolCredentialRequest
) => Promise<BotToolCredentialAnswer>

/** Headers a credential's source adds per request, such as a hub's current key; null when it has none. */
export type BotToolHeaderSource = (
  credential: BotToolCredential
) => Record<string, string> | null | Promise<Record<string, string> | null>

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function botToolCredentialSource(
  headerSources: Readonly<Record<string, BotToolHeaderSource>> = {}
): BotToolCredentialSource {
  return async (request) => {
    const key: BotToolOAuthKey = { folder: request.folder, credentialId: request.credentialId }
    // The store opens only entries sealed for this folder and id; the address must also be the tool's.
    const toolUrl = await botToolUrlOf(request.folder, request.credentialId)
    const stored = botToolCredentialsReader(request.folder)
    const signIn = stored.oauth(request.credentialId)
    if (signIn && signIn.url !== toolUrl) {
      return { kind: 'missing' }
    }
    if (signIn) {
      let grant: Awaited<ReturnType<typeof botToolAccessToken>>
      try {
        grant = request.rejected
          ? await refreshBotToolAccessToken(key, request.rejected, request.signal, signIn)
          : await botToolAccessToken(key, request.signal, signIn)
      } catch {
        // The caller hung up, or a rotated token couldn't be stored: nothing to send now.
        return { kind: 'unavailable' }
      }
      if (!grant) {
        // A refresh the token server didn't answer leaves the sign-in standing.
        return botToolSignInState(key)?.state === 'signed-in'
          ? { kind: 'unavailable' }
          : { kind: 'sign-in-needed' }
      }
      return {
        kind: 'ready',
        url: signIn.url,
        headers: { authorization: `Bearer ${grant.token}` },
        session: digest(['oauth', signIn.url, grant.grant]),
        bearer: grant.token
      }
    }
    const credential = stored.credential(request.credentialId)
    if (!credential || credential.url !== toolUrl) {
      return { kind: 'missing' }
    }
    let sourced: Record<string, string> | null = {}
    if (credential.source) {
      try {
        sourced = (await headerSources[credential.source]?.(credential)) ?? null
      } catch {
        sourced = null
      }
    }
    if (!sourced) {
      return { kind: 'unavailable' }
    }
    const headers = { ...credential.headers, ...sourced }
    return {
      kind: 'ready',
      url: credential.url,
      headers,
      session: digest([credential.url, Object.entries(headers).sort()])
    }
  }
}
