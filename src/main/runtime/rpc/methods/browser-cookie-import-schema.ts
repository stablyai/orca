import { z } from 'zod'
import { OptionalString, requiredString } from '../schemas'

const BrowserCookieImportScopeSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    domains: z.array(z.string().trim().min(1).max(253)).min(1).max(16),
    sourceHostname: z.string().trim().min(1).max(253)
  })
  .strict()

export const ProfileImportFromBrowser = z
  .object({
    profileId: requiredString('Missing required --profile'),
    browserFamily: requiredString('Missing required --browser-family'),
    browserProfile: OptionalString,
    webAiProvider: z.enum(['chatgpt', 'claude', 'deepseek', 'gemini', 'aistudio']).optional(),
    cookieImportScope: BrowserCookieImportScopeSchema.optional()
  })
  .refine((value) => !(value.webAiProvider && value.cookieImportScope), {
    message: 'Choose either a Web AI provider or a custom cookie import scope.'
  })
