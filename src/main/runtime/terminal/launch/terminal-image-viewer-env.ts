import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from '../../../../shared/terminal/images/terminal-image-viewer-capability'
import type { RpcContext } from '../../rpc/core'

export function terminalImageViewerSupported(
  context: Pick<
    RpcContext,
    'caller' | 'clientKind' | 'clientId' | 'pairedDeviceId' | 'connectionId' | 'clientCapabilities'
  >
): boolean | undefined {
  if (context.caller?.kind === 'desktop') {
    return undefined
  }
  if (
    context.caller?.kind === 'local-cli' &&
    context.clientKind === undefined &&
    context.clientId === undefined &&
    context.pairedDeviceId === undefined &&
    context.connectionId === undefined
  ) {
    return undefined
  }
  return (
    context.caller?.kind === 'paired-device' &&
    context.clientKind === 'runtime' &&
    context.clientCapabilities?.includes(TERMINAL_IMAGE_VIEWER_CAPABILITY) === true
  )
}
