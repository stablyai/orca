import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Unread bodies stay opaque; acceptance alone decides these mutations.
export const sessionWriteUnreadReplySchema = z.unknown()

// Bare legacy success and delegated closes do not prove permanent retirement.
export const sessionTabCloseReplySchema = z
  .looseObject({
    closed: z.unknown().optional(),
    refused: z.unknown().optional(),
    retirementConfirmed: z.unknown().optional()
  })
  .catch({})
  .transform((reply) => ({
    refused: reply.refused === true,
    retirementConfirmed:
      reply.closed === true &&
      reply.retirementConfirmed === true &&
      (reply.refused === undefined || reply.refused === false)
  }))

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
