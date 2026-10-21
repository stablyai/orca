import type { RpcContext } from './core'

/**
 * This host's own phone. It has no host catalog of its own and shows this host's view, so it shares
 * this host's Workspace options. A delegated phone belongs to another desktop, and paired desktops
 * and web clients keep their own view (PAIRING_LOCAL_UI_FIELDS).
 */
export function isHostOwnPhone(
  context: Pick<RpcContext, 'clientKind' | 'pairedDeviceParentId'>
): boolean {
  return context.clientKind === 'mobile' && context.pairedDeviceParentId === undefined
}
