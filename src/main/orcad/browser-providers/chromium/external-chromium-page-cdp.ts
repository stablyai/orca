import WebSocket from 'ws'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { BrowserError } from '../../../browser/browser-error'
import type { CdpCommandSender } from '../../../browser/cdp/debugger/cdp-command-sender'
import type {
  AgentBrowserTab,
  ExternalChromiumBrowserSession
} from './external-chromium-browser-session'
import type { PageInputSession } from './external-chromium-page-input'

const CDP_COMMAND_TIMEOUT_MS = 10_000
const AgentBrowserCdpUrl = lazyZodSchema(() => z.object({ cdpUrl: z.string() }))
const CdpReply = lazyZodSchema(() =>
  z.object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.object({ message: z.string().optional() }).optional()
  })
)
const AttachedSession = lazyZodSchema(() => z.object({ sessionId: z.string() }))

/**
 * agent-browser has no raw CDP verb, so commands it lacks (cookie delete by name) open a second
 * CDP client on its browser endpoint, scoped to one page's session, and close it afterwards.
 */
export async function withExternalChromiumPageCdp<T>(
  session: PageInputSession,
  browser: Pick<ExternalChromiumBrowserSession, 'readTabs'>,
  agentPageId: string,
  run: (send: CdpCommandSender, tab: AgentBrowserTab) => Promise<T>
): Promise<T> {
  const { cdpUrl } = AgentBrowserCdpUrl.parse(await session.run(['get', 'cdp-url']))
  const tab = (await browser.readTabs()).find((candidate) => candidate.tabId === agentPageId)
  if (!tab?.targetId) {
    throw new BrowserError('browser_tab_not_found', `Browser tab ${agentPageId} is not open.`)
  }
  const socket = await openSocket(cdpUrl)
  try {
    const call = cdpCaller(socket)
    const { sessionId } = AttachedSession.parse(
      await call('Target.attachToTarget', { targetId: tab.targetId, flatten: true })
    )
    return await run((method, params) => call(method, params, sessionId), tab)
  } finally {
    socket.close()
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: CDP_COMMAND_TIMEOUT_MS })
    socket.once('open', () => resolve(socket))
    // Kept for the socket's life: an unhandled late error would crash orcad; `close` follows it.
    socket.on('error', (error) =>
      reject(
        new BrowserError('browser_error', `Browser DevTools connection failed: ${error.message}`)
      )
    )
  })
}

function cdpCaller(
  socket: WebSocket
): (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> {
  let nextId = 0
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const failAll = (error: Error): void => {
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
  }
  socket.on('message', (data) => {
    let reply: z.infer<typeof CdpReply>
    try {
      reply = CdpReply.parse(JSON.parse(data.toString()))
    } catch {
      // Events carry no id.
      return
    }
    const waiter = pending.get(reply.id)
    pending.delete(reply.id)
    if (reply.error) {
      waiter?.reject(new BrowserError('browser_error', reply.error.message ?? 'CDP command failed'))
    } else {
      waiter?.resolve(reply.result)
    }
  })
  socket.on('close', () =>
    failAll(new BrowserError('browser_error', 'Browser DevTools connection closed.'))
  )
  return (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new BrowserError('browser_timeout', `${method} timed out.`))
      }, CDP_COMMAND_TIMEOUT_MS)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      socket.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }))
    })
}
