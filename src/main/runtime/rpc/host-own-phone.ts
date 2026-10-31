import type { RpcContext } from './core'

/** This host's own phone shares its Workspace options; delegated phones, paired desktops and web clients retain their own view (PAIRING_LOCAL_UI_FIELDS). */
export function isHostOwnPhone(
  context: Pick<RpcContext, 'clientKind' | 'pairedDeviceParentId'>
): boolean {
  return context.clientKind === 'mobile' && context.pairedDeviceParentId === undefined
}
