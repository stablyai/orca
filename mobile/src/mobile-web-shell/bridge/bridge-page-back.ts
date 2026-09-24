/**
 * The device Back key, in the two places it is named: the page's claim on it, and the frame that
 * hands one press over. Negotiated both ways, because each is a closed list on the other side — a
 * claim to a shell that never advertised it is an error frame per mount on every shell installed,
 * and a `back` to a page that never asked for one is a frame its reader drops.
 */

/** Page to shell, on `init.accepts`: this document is holding Back, or has let it go. */
export const BRIDGE_BACK_CLAIM_NOTIFY = 'back-claim'

/** Shell to page, on `ready.accepts`: one Back press, handed to whoever claimed it. */
export const BRIDGE_BACK_FRAME = 'back'
