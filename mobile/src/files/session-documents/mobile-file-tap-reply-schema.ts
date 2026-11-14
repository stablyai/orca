import * as z from 'zod'
import '../../../../src/shared/zod-salvage'

// Require an explicit opened verdict so malformed replies cannot masquerade as declined opens.
export const fileTapOpenedSchema = z.looseObject({ opened: z.boolean() })
