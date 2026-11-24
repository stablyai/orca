// "Connect in one trip" for Linear and GitHub: listen on 127.0.0.1, let the cloud send the browser
// through sign-in (and install), then redeem the one-time result it hands back to this computer.
import { randomBytes } from 'node:crypto'
import { serveLoopbackCallback } from '../orca-profiles/cloud-auth/loopback-callback'
import { orcaCallbackSuccessPage } from '../orca-profiles/cloud-auth/profile-cloud-callback-page'
import type { BotSlackResult } from '../../shared/connector-bot-slack-contract'
import type { ConnectorConnectSource } from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_CONNECT_CODE_PATTERN,
  CONNECTOR_CONNECT_LOOPBACK_PATH,
  type ConnectorConnectError,
  type ConnectorConnectRedeem
} from '../../../cloud/packages/connector-contract/src/connect-messages'
import {
  createConnectLoginKey,
  openConnectLogin,
  type ConnectLogin
} from '../../../cloud/packages/connector-contract/src/connect-login-seal'
import type { botsCloudClient } from './bots-cloud-client'

type ConnectClient = Pick<ReturnType<typeof botsCloudClient>, 'startConnect' | 'redeemConnect'>

// The life of the cloud's connect session and of its result code.
const CONNECT_TIMEOUT_MS = 10 * 60_000

const SOURCE_LABELS: Record<ConnectorConnectSource, string> = { linear: 'Linear', github: 'GitHub' }

const EXPIRED: ConnectorConnectError = 'expired'

const FLOW_ERRORS = {
  timeout: EXPIRED,
  cancelled: 'cancelled',
  unavailable: 'loopback_unavailable',
  failed: 'failed'
} as const

type LoginKey = ReturnType<typeof createConnectLoginKey>
/** GitHub: the trip adds access, for the org or user login named if any. */
export type ConnectAddAccess = { workspace?: string }
// Saves the person's own login a trip handed this computer (Linear), with whom it linked.
export type KeepConnectLogin = (
  login: ConnectLogin,
  linked: ConnectorConnectRedeem
) => void | Promise<void>

const running = new Map<ConnectorConnectSource, AbortController>()
// When a trip that ended at "Open Orca" stops accepting its deep link, and the key its login is
// sealed to; only such a trip redeems one.
const fallbacks = new Map<ConnectorConnectSource, { until: number; loginKey: LoginKey | null }>()

/** A trip the host's Orca account changed under: its redeem would be refused, so it ends now. */
export const CONNECT_ACCOUNT_CHANGED = 'account_changed'

/** Stops a trip still waiting on the browser; its listener closes and its "Open Orca" link is refused. */
export function cancelConnectorConnect(source: ConnectorConnectSource): void {
  running.get(source)?.abort()
  fallbacks.delete(source)
}

/** The host signed in, out or to another account: every trip in flight ends, saying so. */
export function cancelConnectorConnectsForAccountChange(): void {
  for (const controller of running.values()) {
    controller.abort(CONNECT_ACCOUNT_CHANGED)
  }
  fallbacks.clear()
}

// Opens and keeps the login the redeem carries, which only this computer's key opens; the
// renderer gets the link without it.
async function keptLogin(
  redeemed: BotSlackResult<ConnectorConnectRedeem>,
  loginKey: LoginKey | null,
  keepLogin: KeepConnectLogin | undefined
): Promise<BotSlackResult<ConnectorConnectRedeem>> {
  if (!redeemed.ok) {
    return redeemed
  }
  const { sealedLogin, ...linked } = redeemed.value
  const login = sealedLogin && loginKey ? openConnectLogin(loginKey, sealedLogin) : null
  if (login && keepLogin) {
    try {
      // Saved before the redeem reports success: an immediate status read or a quit must find it.
      await keepLogin(login, linked)
    } catch (error) {
      console.warn('[connector] could not save the Linear login', error)
    }
  }
  return { ok: true, value: linked }
}

/** Redeems an "Open Orca" deep link, but only for a trip this app started without a loopback. */
export async function redeemConnectorFallback(
  source: ConnectorConnectSource,
  client: Pick<ConnectClient, 'redeemConnect'>,
  result: string,
  keepLogin?: KeepConnectLogin
): Promise<BotSlackResult<ConnectorConnectRedeem>> {
  const fallback = fallbacks.get(source)
  if (!fallback || fallback.until <= Date.now()) {
    fallbacks.delete(source)
    return { ok: false, error: EXPIRED }
  }
  const redeemed = await client.redeemConnect(source, result)
  if (redeemed.ok) {
    fallbacks.delete(source)
  }
  return await keptLogin(redeemed, fallback.loginKey, keepLogin)
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** A cloud or flow code as the renderer's copy knows them; anything else is a plain failure. */
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^[a-z_]{1,64}$/.test(message) ? message : FLOW_ERRORS.failed
}

/**
 * One trip: resolves with the linked account, or with null when no port could be opened and the trip
 * ends at "Open Orca" instead (that link is redeemed by `redeemConnect`). A newer trip cancels this one.
 */
export async function connectConnector(
  source: ConnectorConnectSource,
  client: ConnectClient,
  options: {
    switchAccount: boolean
    openExternal: (url: string) => Promise<void>
    // Also ask for the person's own login, sealed to a key this trip alone holds.
    keepLogin?: KeepConnectLogin
    addAccess?: ConnectAddAccess
  }
): Promise<BotSlackResult<ConnectorConnectRedeem | null>> {
  running.get(source)?.abort()
  fallbacks.delete(source)
  const controller = new AbortController()
  running.set(source, controller)
  const nonce = base64Url(randomBytes(32))
  const loginKey = options.keepLogin ? createConnectLoginKey() : null
  let listening = false

  const start = async (loopback: { port: number; nonce: string } | null): Promise<void> => {
    const started = await client.startConnect(source, {
      loopback,
      switchAccount: options.switchAccount,
      ...(loginKey ? { loginKey: loginKey.publicKey } : {}),
      ...(options.addAccess ? { addAccess: options.addAccess } : {})
    })
    if (!started.ok) {
      throw new Error(started.error)
    }
    // Cancelled while the cloud answered: no browser for a trip nobody waits on.
    if (controller.signal.aborted) {
      throw new Error(FLOW_ERRORS.cancelled)
    }
    if (loopback === null) {
      fallbacks.set(source, { until: Date.now() + CONNECT_TIMEOUT_MS, loginKey })
    }
    await options.openExternal(started.value.authorizeUrl)
  }

  try {
    const result = await serveLoopbackCallback<string>({
      path: CONNECTOR_CONNECT_LOOPBACK_PATH,
      timeoutMs: CONNECT_TIMEOUT_MS,
      signal: controller.signal,
      successPage: orcaCallbackSuccessPage(`Signed in to ${SOURCE_LABELS[source]}`),
      errors: FLOW_ERRORS,
      read: (url) => {
        const code = url.searchParams.get('r')
        // Only this trip's nonce counts; probes and stale tabs leave the trip waiting.
        return url.searchParams.get('n') === nonce &&
          code !== null &&
          CONNECTOR_CONNECT_CODE_PATTERN.test(code)
          ? { kind: 'accept', value: code }
          : {
              kind: 'stray',
              message: 'This sign-in is not for this Orca. Return to Orca and try again.'
            }
      },
      onListening: (port) => {
        listening = true
        return start({ port, nonce })
      }
    })
    return await keptLogin(await client.redeemConnect(source, result), loginKey, options.keepLogin)
  } catch (error) {
    if (controller.signal.reason === CONNECT_ACCOUNT_CHANGED) {
      return { ok: false, error: CONNECT_ACCOUNT_CHANGED }
    }
    if (!listening && !controller.signal.aborted) {
      // No port on this computer: the trip ends at "Open Orca", whose link comes back as a deep link.
      try {
        await start(null)
        return { ok: true, value: null }
      } catch (fallbackError) {
        fallbacks.delete(source)
        return { ok: false, error: errorCode(fallbackError) }
      }
    }
    return { ok: false, error: errorCode(error) }
  } finally {
    if (running.get(source) === controller) {
      running.delete(source)
    }
  }
}
