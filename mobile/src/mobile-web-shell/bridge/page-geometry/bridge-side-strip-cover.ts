import * as z from 'zod'
import { BRIDGE_MAX_SAFE_AREA_INSET } from './bridge-safe-area-insets'

/**
 * The grant a session page declares, optionally, when it reports whether it lays itself across the
 * side strip (the iPhone Duo's status column). The shell then keeps its own rail content, such as
 * usage rings, off the strip only while the page is drawn there.
 */
export const BRIDGE_SIDE_STRIP_COVER_GRANT = 'sideStripCover'

/** Page to shell, a notify on that grant: whole state, sent on change and again on each `init`. */
export const BRIDGE_SIDE_STRIP_COVER_NOTIFY = 'side-strip-cover'

const coordinate = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)

/**
 * The span of the strip a covering page leaves empty, from `top` to `bottom` in page points, such as
 * a collapsed chat's column between its back button and jump arrows. The shell may draw there.
 */
export const BridgeSideStripFreeSchema = z.object({ top: coordinate, bottom: coordinate })

export type BridgeSideStripFree = z.infer<typeof BridgeSideStripFreeSchema>
