import { z } from 'zod'

// Require uploadId because every append/commit/abort addresses that slot.
export const clipboardImageUploadSlotSchema = z.looseObject({ uploadId: z.string() })

// Require a path string; paste formatting calls split and cannot safely accept other shapes.
export const clipboardImagePathSchema = z.string()

// Acknowledgement/abort payloads are unread, so impose no unused requirements.
export const clipboardImageUnreadReplySchema = z.unknown()
