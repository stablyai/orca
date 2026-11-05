import type { RpcContext } from './core'

export function generationOwner(
  context: Pick<RpcContext, 'pairedDeviceId' | 'caller'>,
  requestLabel = 'title',
  allowDesktop = false
): string {
  // One-shot RPCs use different sockets for Generate and Stop.
  if (context.pairedDeviceId) {
    return `device:${context.pairedDeviceId}`
  }
  if (context.caller?.kind === 'paired-device') {
    return `device:${context.caller.deviceId}`
  }
  if (context.caller?.kind === 'local-cli') {
    return 'local-cli'
  }
  if (allowDesktop && context.caller?.kind === 'desktop') {
    return 'desktop'
  }
  throw new Error(`A ${requestLabel} generation request needs an authenticated connection.`)
}
