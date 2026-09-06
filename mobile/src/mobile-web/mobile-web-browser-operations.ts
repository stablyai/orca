import {
  MobileWebBrowserCommandResultSchema,
  MobileWebBrowserDialogPayloadSchema,
  MobileWebBrowserKeyboardPayloadSchema,
  MobileWebBrowserNavigatePayloadSchema,
  MobileWebBrowserNavigateResultSchema,
  MobileWebBrowserPointerPayloadSchema,
  MobileWebBrowserTargetPayloadSchema
} from '../../../src/shared/mobile-web/browser-operation-contract'
import { mobileWebPageBrowserUrl } from '../../../src/shared/mobile-web/browser-url-privacy'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebBrowserOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
  browserAuthority: MobileWebBrowserAuthority
}): Promise<unknown> {
  if (args.operation === 'navigate') {
    const payload = MobileWebBrowserNavigatePayloadSchema.parse(args.payload)
    const target = resolveTarget(payload, args.workspaceAuthority, args.browserAuthority)
    const response = await args.client.sendRequest(
      'browser.goto',
      { ...target, url: payload.url },
      { timeoutMs: 30_000 }
    )
    const result = requireResult(response)
    const parsed = MobileWebBrowserNavigateResultSchema.safeParse({
      url: isRecord(result) ? mobileWebPageBrowserUrl(result.url) : 'about:blank'
    })
    if (!parsed.success) {
      throw new MobileWebBrokerError('host_error')
    }
    return parsed.data
  }
  if (args.operation === 'pointer') {
    const payload = MobileWebBrowserPointerPayloadSchema.parse(args.payload)
    const target = resolveTarget(payload, args.workspaceAuthority, args.browserAuthority)
    if (payload.action === 'scroll') {
      await requireRequest(args.client, 'browser.mouseMove', {
        ...target,
        x: payload.x,
        y: payload.y
      })
      assertTarget(payload, target, args.workspaceAuthority, args.browserAuthority)
      await requireRequest(args.client, 'browser.mouseWheel', {
        ...target,
        dx: payload.dx,
        dy: payload.dy
      })
      return MobileWebBrowserCommandResultSchema.parse(null)
    }
    const click = await args.client.sendRequest(
      'browser.mouseClick',
      {
        ...target,
        x: payload.x,
        y: payload.y,
        button: payload.button,
        modifiers: payload.modifiers,
        ...(payload.radius === undefined ? {} : { radius: payload.radius })
      },
      { timeoutMs: 5_000 }
    )
    if (!click.ok && payload.modifiers.length === 0) {
      assertTarget(payload, target, args.workspaceAuthority, args.browserAuthority)
      await requireRequest(args.client, 'browser.mouseMove', {
        ...target,
        x: payload.x,
        y: payload.y
      })
      assertTarget(payload, target, args.workspaceAuthority, args.browserAuthority)
      await requireRequest(args.client, 'browser.mouseDown', {
        ...target,
        button: payload.button
      })
      assertTarget(payload, target, args.workspaceAuthority, args.browserAuthority)
      await requireRequest(args.client, 'browser.mouseUp', {
        ...target,
        button: payload.button
      })
    }
    return MobileWebBrowserCommandResultSchema.parse(null)
  }
  if (args.operation === 'keyboard') {
    const payload = MobileWebBrowserKeyboardPayloadSchema.parse(args.payload)
    const target = resolveTarget(payload, args.workspaceAuthority, args.browserAuthority)
    await requireRequest(
      args.client,
      payload.action === 'insertText' ? 'browser.keyboardInsertText' : 'browser.keypress',
      payload.action === 'insertText'
        ? { ...target, text: payload.text }
        : { ...target, key: payload.key },
      5_000
    )
    return MobileWebBrowserCommandResultSchema.parse(null)
  }
  if (args.operation === 'dialog') {
    const payload = MobileWebBrowserDialogPayloadSchema.parse(args.payload)
    const target = resolveTarget(payload, args.workspaceAuthority, args.browserAuthority)
    await requireRequest(
      args.client,
      payload.action === 'accept' ? 'browser.dialogAccept' : 'browser.dialogDismiss',
      target,
      5_000
    )
    return MobileWebBrowserCommandResultSchema.parse(null)
  }
  if (args.operation === 'back' || args.operation === 'forward' || args.operation === 'reload') {
    const payload = MobileWebBrowserTargetPayloadSchema.parse(args.payload)
    const target = resolveTarget(payload, args.workspaceAuthority, args.browserAuthority)
    await requireRequest(args.client, `browser.${args.operation}`, target)
    return MobileWebBrowserCommandResultSchema.parse(null)
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function assertTarget(
  payload: { workspaceId: string; pageId: string },
  expected: { worktree: string; page: string },
  workspaceAuthority: MobileWebWorkspaceAuthority,
  browserAuthority: MobileWebBrowserAuthority
): void {
  const current = resolveTarget(payload, workspaceAuthority, browserAuthority)
  if (current.worktree !== expected.worktree || current.page !== expected.page) {
    throw new MobileWebBrokerError('conflict')
  }
}

function resolveTarget(
  payload: { workspaceId: string; pageId: string },
  workspaceAuthority: MobileWebWorkspaceAuthority,
  browserAuthority: MobileWebBrowserAuthority
): { worktree: string; page: string } {
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  return {
    worktree: `id:${hostWorkspaceId}`,
    page: browserAuthority.hostPageId(hostWorkspaceId, payload.pageId)
  }
}

async function requireRequest(
  client: RpcClient,
  method: string,
  payload: unknown,
  timeoutMs = 15_000
): Promise<void> {
  requireResult(await client.sendRequest(method, payload, { timeoutMs }))
}

function requireResult(response: Awaited<ReturnType<RpcClient['sendRequest']>>): unknown {
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return response.result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
