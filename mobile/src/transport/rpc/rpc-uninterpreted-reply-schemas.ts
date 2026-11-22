import * as z from 'zod'

// Leave unread replies opaque; structured creates/probes require raw-envelope uncertainty checks at their callers.
export const sessionLaunchUnreadReplySchema = z.unknown()

// Keep generic tab snapshots and legacy error/window history unions opaque until callers can select their shape.
export const sessionForwardedReplySchema = z.unknown()

// Unread bodies stay opaque; acceptance alone decides these mutations.
export const sessionWriteUnreadReplySchema = z.unknown()
