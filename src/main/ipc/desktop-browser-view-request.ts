import { z } from 'zod'
import { DesktopBrowserViewInputSchema } from '../../shared/desktop-browser-view-input'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import type {
  DesktopBrowserViewCommandArgs,
  DesktopBrowserViewCreateArgs,
  DesktopBrowserViewIdentity,
  DesktopBrowserViewLayout
} from '../../shared/desktop-browser-view-protocol'

const id = z.string().min(1).max(512)
const url = z
  .string()
  .max(131072)
  .transform((value, context) => {
    const normalized = normalizeBrowserNavigationUrl(value)
    if (!normalized) {
      context.addIssue({ code: 'custom', message: 'Unsupported browser navigation URL' })
      return z.NEVER
    }
    return normalized
  })

export const desktopBrowserViewIdentitySchema: z.ZodType<DesktopBrowserViewIdentity> = z
  .object({ browserPageId: id, generation: id })
  .strict()

export const desktopBrowserViewCreateSchema: z.ZodType<DesktopBrowserViewCreateArgs> = z
  .object({
    browserPageId: id,
    workspaceId: id,
    worktreeId: id,
    sessionProfileId: id.nullable(),
    url
  })
  .strict()

const bounds = z
  .object({
    x: z.number().int().min(-65535).max(65535),
    y: z.number().int().min(-65535).max(65535),
    width: z.number().int().min(1).max(32768),
    height: z.number().int().min(1).max(32768)
  })
  .strict()

export const desktopBrowserViewLayoutSchema: z.ZodType<DesktopBrowserViewLayout> = z
  .object({
    browserPageId: id,
    generation: id,
    bounds,
    clipBounds: bounds.optional(),
    visible: z.boolean(),
    inputLocked: z.boolean(),
    forwardInput: z.boolean().optional()
  })
  .strict()

export const desktopBrowserViewInputSchema = z
  .object({
    browserPageId: id,
    generation: id,
    input: DesktopBrowserViewInputSchema
  })
  .strict()

export const desktopBrowserViewCommandSchema: z.ZodType<DesktopBrowserViewCommandArgs> = z
  .object({
    browserPageId: id,
    generation: id,
    command: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('snapshot') }).strict(),
      z.object({ kind: z.literal('navigate'), url }).strict(),
      z.object({ kind: z.literal('back') }).strict(),
      z.object({ kind: z.literal('forward') }).strict(),
      z.object({ kind: z.literal('reload'), ignoreCache: z.boolean() }).strict(),
      z.object({ kind: z.literal('stop') }).strict(),
      z.object({ kind: z.literal('zoom'), level: z.number().finite().min(-10).max(10) }).strict(),
      z
        .object({
          kind: z.literal('find'),
          text: z.string().min(1).max(8192),
          forward: z.boolean(),
          findNext: z.boolean(),
          matchCase: z.boolean()
        })
        .strict(),
      z
        .object({
          kind: z.literal('stop-find'),
          action: z.enum(['clearSelection', 'keepSelection', 'activateSelection'])
        })
        .strict(),
      z.object({ kind: z.literal('focus') }).strict(),
      z.object({ kind: z.literal('blur') }).strict()
    ])
  })
  .strict()
