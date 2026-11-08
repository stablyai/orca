import * as z from 'zod'
import '../../../../src/shared/zod-salvage'

// Preserve null for unreadable canonical command lists so load/save cannot erase host commands with an invented empty list.
export const terminalQuickCommandsSchema = z
  .looseObject({ terminalQuickCommands: z.unknown().optional() })
  .nullish()
  .transform((reply) => reply?.terminalQuickCommands)
