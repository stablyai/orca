/**
 * Shell to page, a frame: the app came back from the background, or the shell is about to reload
 * onto a newer build. A page that reads it says so in `ready` and answers with a `swapSafe` notify
 * carrying the frame's round, whether the shell may reload it now. Older pages never receive one
 * and never answer, so the shell never reloads them.
 */
import type { BRIDGE_APP_INACTIVE_FRAME } from './bridge-app-inactive'

export const BRIDGE_APP_RESUMED_FRAME = 'appResumed'

export type BridgeAppFrame =
  | { readonly type: typeof BRIDGE_APP_INACTIVE_FRAME }
  | {
      readonly type: typeof BRIDGE_APP_RESUMED_FRAME
      readonly round: number
      readonly reloading?: true
    }

export const BRIDGE_SWAP_SAFE_NOTIFY = 'swapSafe'
