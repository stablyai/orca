// `item:` refs (item add --link, item link, item list --link), checked before they are sent: an older
// host keeps one as a file path, so it is refused here instead.
import { BOTS_ITEM_LINKS_RUNTIME_CAPABILITY } from '../../shared/bot-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'

/** Asks the host only when a ref names an item; any other ref goes as it always has. */
export async function assertItemLinkRefsSupported(
  client: Pick<HandlerContext['client'], 'call'>,
  refs: readonly string[]
): Promise<void> {
  if (!refs.some((ref) => ref.trim().startsWith('item:'))) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(BOTS_ITEM_LINKS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot link items to other items (item:<n>). Update Orca on that host.'
    )
  }
}
