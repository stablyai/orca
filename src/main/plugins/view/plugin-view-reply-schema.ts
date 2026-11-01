import { z } from 'zod'
import type { PluginViewReply } from '../../../shared/plugins/view/plugin-view-protocol'
import {
  PLUGIN_SHOT_MAX_ACTS,
  pluginShotActResultSchema
} from '../../../shared/plugins/view/plugin-shot-acts'

const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative()
})

const drawnPanelSchema = z.object({
  rect: rectSchema,
  ui: z.enum(['components', 'html']),
  guestUrl: z.string().max(8192).nullable(),
  guestRect: rectSchema.optional(),
  issue: z.string().max(4000).nullable(),
  colorScheme: z.enum(['light', 'dark']),
  themeApplied: z.boolean(),
  settled: z.boolean(),
  pendingRequests: z.number().int().nonnegative().optional(),
  actions: z.array(pluginShotActResultSchema).max(PLUGIN_SHOT_MAX_ACTS).optional()
})

/** The renderer's reply, checked before main captures a rect it names. */
export const pluginViewReplySchema: z.ZodType<PluginViewReply> = z.union([
  z.object({
    requestId: z.string().max(128),
    ok: z.literal(true),
    panel: drawnPanelSchema.optional(),
    restored: z.boolean().optional()
  }),
  z.object({
    requestId: z.string().max(128),
    ok: z.literal(false),
    code: z.string().max(64),
    message: z.string().max(2000)
  })
])
