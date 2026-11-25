export const BRIDGE_BACK_CLAIM_NOTIFY = 'back-claim'

export const BRIDGE_BACK_FRAME = 'back'

/**
 * A horizontal band of the page, in CSS pixels from its top, where a swipe from the screen's
 * edge belongs to the page (the session tab bar steps tabs) rather than to Back. Sent with the
 * Back claim; shells from before it strip the field and keep their edge swipe everywhere.
 */
export type BridgeBackEdgeGuard = { readonly top: number; readonly bottom: number }

/** More bands than the page ever draws; a cap keeps a bad page from flooding the shell. */
export const BRIDGE_BACK_EDGE_GUARD_LIMIT = 4
