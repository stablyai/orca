import * as z from 'zod'
import { salvagingArray, salvagedOptional } from '../../../../src/shared/zod-salvage'

// Require an inventory/handle for strip reconciliation; salvage individual malformed rows without erasing valid ones.
export const sessionTerminalInventorySchema = z.looseObject({
  terminals: salvagingArray(z.looseObject({ handle: z.string() }))
})

// Require terminal kind and addressable id before strip adoption; salvage optional guarded fields and preserve newer host members.
export const sessionCreatedTerminalTabSchema = z
  .looseObject({
    tab: z.looseObject({
      type: z.literal('terminal'),
      id: z.string().min(1),
      terminal: salvagedOptional('terminal', z.string().nullable()),
      title: salvagedOptional('title', z.string()),
      terminalTheme: salvagedOptional('terminalTheme', z.unknown())
    })
  })
  .transform((reply) => reply.tab)

export function createdTerminalDesktopWarning(raw: unknown): boolean {
  return z.looseObject({ warning: z.literal('desktop-tab-not-shown') }).safeParse(raw).success
}

/** A tab tap whose terminal restarted at the workspace root because its saved folder is gone. */
export function activatedAtWorkspaceRoot(raw: unknown): boolean {
  return z.looseObject({ startupCwdFallback: z.literal('workspace-root') }).safeParse(raw).success
}
