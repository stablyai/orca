import type { InitializeRequest, ClientCapabilities } from '../generated/acp-protocol.generated'
import type { AcpPeerHandlers, AcpRequestContext } from '../transport/acp-json-rpc-peer'
import type { AcpPeerOptions } from '../transport/acp-peer-limits'
import type { AcpPermissionHandler } from './acp-permission-requests'

export type AcpSessionRuntimeOptions = {
  /** OMP's typed busy refusal confirms this prompt never ran. */
  retryBusyPrompts?: boolean
  clientInfo?: InitializeRequest['clientInfo']
  clientCapabilities?: Pick<ClientCapabilities, 'elicitation' | '_meta'>
  peer?: AcpPeerOptions
  onPermission?: AcpPermissionHandler
  /** After abort, handlers still reply or throw (-32800); close ends unanswered requests. */
  onRequest?: (method: string, params: unknown, context: AcpRequestContext) => unknown
  /** Delivered synchronously in arrival order with subscription events. */
  onExtensionNotification?: (method: string, params: unknown) => void
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
  onOutputEnd?: AcpPeerHandlers['onOutputEnd']
  onOtherLine?: (line: string, cut?: boolean) => void
  /** Authentication answers, published synchronously as responses are accepted. */
  onAuthAnswered?: (signedIn: boolean) => void
}
