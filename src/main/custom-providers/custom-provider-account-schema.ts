import { z } from 'zod'

export const CustomProviderAccount = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    enabled: z.boolean(),
    icon: z.string().optional(),
    usageUrl: z.string().startsWith('https://', 'usageUrl must start with https://'),
    tokenEnvVar: z.string().optional(),
    mappingMode: z.enum(['percent', 'used-limit']),
    percentPath: z.string().optional(),
    usedPaths: z.array(z.string().min(1)).min(1).max(4).optional(),
    limitPath: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .strict()
  .superRefine((account, ctx) => {
    if (account.mappingMode === 'percent' && !account.percentPath?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'percentPath is required when mappingMode is "percent"',
        path: ['percentPath']
      })
    }
    if (account.mappingMode === 'used-limit') {
      if (!account.usedPaths || account.usedPaths.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'usedPaths is required when mappingMode is "used-limit"',
          path: ['usedPaths']
        })
      }
      if (!account.limitPath?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'limitPath is required when mappingMode is "used-limit"',
          path: ['limitPath']
        })
      }
    }
  })

export const CustomProviderAccountList = z
  .array(CustomProviderAccount)
  .superRefine((accounts, ctx) => {
    const seenIds = new Set<string>()
    const seenNames = new Set<string>()
    accounts.forEach((account, index) => {
      if (seenIds.has(account.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate account id: ${account.id}`,
          path: [index, 'id']
        })
      }
      seenIds.add(account.id)
      const nameKey = account.displayName.trim().toLowerCase()
      if (seenNames.has(nameKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate account name: ${account.displayName}`,
          path: [index, 'displayName']
        })
      }
      seenNames.add(nameKey)
    })
  })
