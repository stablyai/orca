import type { AcpPeerOptions, AcpRequestContext } from './acp-json-rpc-peer'
import type { AcpPermissionHandler } from './acp-permission-requests'
import type { InitializeRequest } from './generated/acp-protocol.generated'

export type AcpSessionRuntimeOptions = {
  clientInfo?: InitializeRequest['clientInfo']
  peer?: AcpPeerOptions
  onPermission?: AcpPermissionHandler
  /** After abort, handlers still reply or throw (-32800); close ends unanswered requests. */
  onRequest?: (method: string, params: unknown, context: AcpRequestContext) => unknown
  /** Delivered synchronously in arrival order with subscription events. */
  onExtensionNotification?: (method: string, params: unknown) => void
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
  onOtherLine?: (line: string, cut?: boolean) => void
  /** Authentication answers, published synchronously as responses are accepted. */
  onAuthAnswered?: (signedIn: boolean) => void
  normalizePromptError?: (
    error: Error,
    context: { sessionId: string; startedAt: number; closed: () => boolean }
  ) => Error | Promise<Error>
}
