import * as z from 'zod'

// Require an explicit opened verdict so malformed replies cannot masquerade as declined opens.
export const fileTapOpenedSchema = z.looseObject({ opened: z.boolean() })
