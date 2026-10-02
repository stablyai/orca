/** The device Back key, in the two places it is named: the page's claim on it, and the frame that
 *  hands one press over. */

/** Page to shell, a notify: this document is holding Back, or has let it go. */
export const BRIDGE_BACK_CLAIM_NOTIFY = 'back-claim'

/** Shell to page, a frame: one Back press, handed to whoever claimed it. */
export const BRIDGE_BACK_FRAME = 'back'
