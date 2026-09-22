import { vi } from 'vitest'
import type {
  BrowserClientPageRendererReply,
  BrowserClientPageRendererRequest
} from '../../shared/browser-client-page-renderer-protocol'
import {
  BrowserClientPageRendererBridgeRegistry,
  type BrowserClientPageRendererEndpoint,
  type BrowserClientPageRendererReplyEvent
} from './browser-client-page-renderer-bridge'

export const rendererPage = {
  partition: 'persist:orca-browser-route:v1:partition-a',
  browserPageId: 'page-a',
  pageHostGeneration: 7
}

export function createRendererEndpoint(id: number): BrowserClientPageRendererEndpoint {
  return { id, mainFrame: {}, isDestroyed: vi.fn(() => false), send: vi.fn() }
}

export function createRendererBridgeTestRig(options?: {
  maxPending?: number
  timeoutMs?: number
  createRequestId?: () => string
}) {
  let listener: ((event: BrowserClientPageRendererReplyEvent, reply: unknown) => void) | null = null
  let requestSequence = 0
  const transport = {
    onReply: vi.fn(
      (candidate: (event: BrowserClientPageRendererReplyEvent, reply: unknown) => void) => {
        listener = candidate
      }
    ),
    offReply: vi.fn(
      (candidate: (event: BrowserClientPageRendererReplyEvent, reply: unknown) => void) => {
        if (listener === candidate) {
          listener = null
        }
      }
    )
  }
  const registry = new BrowserClientPageRendererBridgeRegistry({
    transport,
    createRequestId: options?.createRequestId ?? (() => `request-${++requestSequence}`),
    timeoutMs: options?.timeoutMs ?? 1_000,
    maxPending: options?.maxPending
  })
  const endpoint = createRendererEndpoint(41)
  return {
    endpoint,
    registry,
    reply(
      sender: BrowserClientPageRendererEndpoint,
      value: unknown,
      senderFrame = sender.mainFrame
    ) {
      listener?.({ sender, senderFrame }, value)
    }
  }
}

export function sentRendererRequest(
  endpoint: BrowserClientPageRendererEndpoint
): BrowserClientPageRendererRequest {
  return vi.mocked(endpoint.send).mock.calls.at(-1)?.[1] as BrowserClientPageRendererRequest
}

export function completeRendererMount(
  rig: ReturnType<typeof createRendererBridgeTestRig>,
  endpoint = rig.endpoint,
  webContentsId = 91,
  senderFrame = endpoint.mainFrame
): void {
  const request = sentRendererRequest(endpoint)
  rig.reply(
    endpoint,
    {
      type: 'mounted',
      requestId: request.requestId,
      page: request.page,
      webContentsId
    } satisfies BrowserClientPageRendererReply,
    senderFrame
  )
}
