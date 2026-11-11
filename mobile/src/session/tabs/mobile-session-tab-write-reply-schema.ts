import * as z from 'zod'

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
