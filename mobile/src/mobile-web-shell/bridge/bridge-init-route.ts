import { z } from 'zod'
import {
  BRIDGE_MAX_ROUTE_PARAM_CHARS,
  BRIDGE_MAX_ROUTE_PARAMS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_ROUTE_PATHNAME_PATTERN
} from './bridge-caps'

// Serve documents only at /, so init must name their screen. Older shells omit route; show a readable refusal rather than Expo’s Unmatched.
// Keep params separate from pathname so the page constructs history once before its first render.
export const BridgeInitRouteSchema = z.object({
  pathname: z
    .string()
    .min(1)
    .max(BRIDGE_MAX_ROUTE_PATHNAME_CHARS)
    .regex(BRIDGE_ROUTE_PATHNAME_PATTERN),
  params: z
    .record(
      z.string().min(1).max(BRIDGE_MAX_ROUTE_PARAM_CHARS),
      z.string().max(BRIDGE_MAX_ROUTE_PARAM_CHARS)
    )
    .refine((params) => Object.keys(params).length <= BRIDGE_MAX_ROUTE_PARAMS)
    .optional()
})

export type BridgeInitRoute = z.infer<typeof BridgeInitRouteSchema>
