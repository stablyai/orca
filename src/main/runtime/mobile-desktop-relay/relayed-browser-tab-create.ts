import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BrowserTabCreateParams } from '../../../shared/rpc-contract/browser-tab-create-params'
import {
  RuntimeRpcEnvelopeSchema,
  type RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import type { RemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type { RelayLink } from './mobile-desktop-relay-link'

/** The desktop owns its browser lease; the phone must still prove access on its delegated socket. */
export async function createRelayedBrowserTab(args: {
  hosts: MobileDesktopRelayHosts
  prepareBrowserHost?: (host: MobileDesktopRelayHost) => Promise<string | null>
  link: RelayLink
  frame: string
  socket: RemoteRuntimePassthroughSocket
  isCurrent: () => boolean
  timeoutMs: number
}): Promise<boolean> {
  const request = z
    .looseObject({ id: z.string(), params: z.unknown().optional() })
    .parse(JSON.parse(args.frame))
  const params = BrowserTabCreateParams.safeParse(request.params)
  const { link } = args
  const { host } = await link.opened
  const { pairingRevision } = host
  if (
    !params.success ||
    !params.data.worktree ||
    params.data.placement ||
    pairingRevision === undefined
  ) {
    return false
  }
  const browserHostClientId = args.prepareBrowserHost
    ? await args.prepareBrowserHost(host)
    : args.hosts.browserHostClientId?.(link.environmentId)
  if (!browserHostClientId) {
    return false
  }
  const create = async (): Promise<RuntimeRpcResponse<unknown>> => {
    const id = `relay-browser-create:${randomUUID()}`
    const admission = RuntimeRpcEnvelopeSchema.parse(
      await link.replies.request(
        id,
        () =>
          args.socket.send(
            JSON.stringify({
              ...request,
              id,
              method: 'session.tabs.list',
              params: { worktree: params.data.worktree }
            })
          ),
        args.timeoutMs
      )
    )
    if (!('ok' in admission)) {
      throw new Error('Unable to confirm browser workspace access.')
    }
    if (!args.isCurrent() || !admission.ok) {
      return admission
    }
    return args.hosts.call(
      host,
      'browser.tabCreate',
      {
        ...params.data,
        // The phone selects the returned page itself; the desktop must not follow its own create.
        activate: false,
        placement: { kind: 'client', browserHostClientId }
      },
      {
        expected: { pairingRevision, runtimeId: admission._meta.runtimeId },
        signal: link.abortController.signal
      }
    )
  }
  const response = await create()
  if (args.isCurrent()) {
    const frame = link.replies.text(JSON.stringify({ ...response, id: request.id }))
    if (frame) {
      link.phone.reply(frame)
    }
  }
  return true
}
