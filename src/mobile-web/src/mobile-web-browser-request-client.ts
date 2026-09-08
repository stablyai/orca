import type { z } from 'zod'
import {
  MobileWebBrowserAckSchema,
  MobileWebBrowserNavigateResultSchema,
  type MobileWebBrowserDialogPayload,
  type MobileWebBrowserKeyboardPayload,
  type MobileWebBrowserNavigatePayload,
  type MobileWebBrowserPointerPayload,
  type MobileWebBrowserTargetPayload
} from '../../shared/mobile-web/browser-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

/** The workspace handle rides in the host request envelope, and the browser page id is the only
 * target field the desktop wrapper reads. */
function hostParams<TPayload extends MobileWebBrowserTargetPayload>({
  workspaceId: _workspaceId,
  pageId,
  ...fields
}: TPayload): Record<string, unknown> {
  return { page: pageId, ...fields }
}

export class MobileWebBrowserRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  async navigate(
    payload: MobileWebBrowserNavigatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<{ url: string }> {
    return this.send(
      'mobileWeb.browser.navigate',
      payload,
      hostParams(payload),
      MobileWebBrowserNavigateResultSchema,
      options
    )
  }

  pointer(
    payload: MobileWebBrowserPointerPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.command('mobileWeb.browser.pointer', payload, hostParams(payload), options)
  }

  keyboard(
    payload: MobileWebBrowserKeyboardPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.command('mobileWeb.browser.keyboard', payload, hostParams(payload), options)
  }

  dialog(
    payload: MobileWebBrowserDialogPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.command('mobileWeb.browser.dialog', payload, hostParams(payload), options)
  }

  back(
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.history('back', payload, options)
  }

  forward(
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.history('forward', payload, options)
  }

  reload(
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.history('reload', payload, options)
  }

  private history(
    action: 'back' | 'forward' | 'reload',
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.command(
      'mobileWeb.browser.history',
      payload,
      { ...hostParams(payload), action },
      options
    )
  }

  private async command(
    method: string,
    payload: MobileWebBrowserTargetPayload,
    params: Record<string, unknown>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    await this.send(method, payload, params, MobileWebBrowserAckSchema, options)
    return null
  }

  private async send<TResult>(
    method: string,
    payload: MobileWebBrowserTargetPayload,
    params: Record<string, unknown>,
    schema: z.ZodType<TResult>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<TResult> {
    const result = await requestMobileWebHost(
      this.requests,
      method,
      payload.workspaceId,
      params,
      options
    )
    const parsed = schema.safeParse(result)
    if (!parsed.success) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    return parsed.data
  }
}
