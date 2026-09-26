import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// The hosted browser's page commands. Checked against src/main/runtime/rpc/methods/browser-core.ts
// and the pointer/keyboard/dialog methods beside it.

/**
 * The URL a navigation settled on.
 *
 * `url` is optional and the payload is nullish, because `typeof result?.url === 'string'` is the
 * whole of what the pane guarded with: a redirect the host reports, a reply that omits the URL and
 * a null result were three shapes that all left the address bar alone. Requiring the object would
 * turn the last of those into an error toast on a user-initiated navigation, and this is the one
 * read site in the batch with no recording family — `navigateToAddress` is inline in
 * MobileBrowserPane.tsx, which no adapter mounts — so that move would ship unevidenced.
 */
export const browserNavigationSettledSchema = z
  .looseObject({
    url: salvagedOptional('url', z.string())
  })
  .nullish()

/**
 * The twelve page commands whose reply body no call site reads.
 *
 * Back, forward, reload, the five pointer sends, the two keyboard sends and the two dialog
 * dismissals are all decided by whether the command was refused: the pane and the commands hook
 * either show the refusal's message or swallow it as a transient automation failure, and none of
 * them looks at the result. Declaring a member on any of them would be a requirement with no reader
 * behind it.
 */
export const browserCommandUnreadReplySchema = z.unknown()
