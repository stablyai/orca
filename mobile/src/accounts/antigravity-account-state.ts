import { z } from 'zod'

const AntigravityAccountSummarySchema = z
  .object({
    id: z.string().min(1),
    email: z.string().nullable(),
    subject: z.string().nullable(),
    authMethod: z.string(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .passthrough()

export const AntigravityAccountStateSchema = z
  .object({
    accounts: z.array(AntigravityAccountSummarySchema),
    activeAccountId: z.string().nullable(),
    currentAccount: z
      .object({
        email: z.string().nullable(),
        subject: z.string().nullable(),
        authMethod: z.string(),
        identityKnown: z.boolean()
      })
      .nullable(),
    selectedAccountId: z.string().nullable()
  })
  .passthrough()

export type AntigravityAccountState = z.infer<typeof AntigravityAccountStateSchema>

export function decodeAntigravityAccountState(value: unknown): AntigravityAccountState | null {
  const result = AntigravityAccountStateSchema.safeParse(value)
  return result.success ? result.data : null
}
