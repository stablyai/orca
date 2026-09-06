import {
  MobileWebBrowserCommandResultSchema,
  MobileWebBrowserDialogPayloadSchema,
  MobileWebBrowserKeyboardPayloadSchema,
  MobileWebBrowserNavigatePayloadSchema,
  MobileWebBrowserNavigateResultSchema,
  MobileWebBrowserPointerPayloadSchema,
  MobileWebBrowserTargetPayloadSchema,
  type MobileWebBrowserDialogPayload,
  type MobileWebBrowserKeyboardPayload,
  type MobileWebBrowserNavigatePayload,
  type MobileWebBrowserPointerPayload,
  type MobileWebBrowserTargetPayload
} from '../../shared/mobile-web/browser-operation-contract'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebBrowserRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  navigate(
    payload: MobileWebBrowserNavigatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<{ url: string }> {
    return this.requests.request(
      'browser',
      'navigate',
      payload,
      MobileWebBrowserNavigatePayloadSchema,
      MobileWebBrowserNavigateResultSchema,
      options
    )
  }

  pointer(
    payload: MobileWebBrowserPointerPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'browser',
      'pointer',
      payload,
      MobileWebBrowserPointerPayloadSchema,
      MobileWebBrowserCommandResultSchema,
      options
    )
  }

  keyboard(
    payload: MobileWebBrowserKeyboardPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'browser',
      'keyboard',
      payload,
      MobileWebBrowserKeyboardPayloadSchema,
      MobileWebBrowserCommandResultSchema,
      options
    )
  }

  dialog(
    payload: MobileWebBrowserDialogPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'browser',
      'dialog',
      payload,
      MobileWebBrowserDialogPayloadSchema,
      MobileWebBrowserCommandResultSchema,
      options
    )
  }

  back(
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.command('back', payload, options)
  }

  forward(
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.command('forward', payload, options)
  }

  reload(
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.command('reload', payload, options)
  }

  private command(
    operation: 'back' | 'forward' | 'reload',
    payload: MobileWebBrowserTargetPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'browser',
      operation,
      payload,
      MobileWebBrowserTargetPayloadSchema,
      MobileWebBrowserCommandResultSchema,
      options
    )
  }
}
