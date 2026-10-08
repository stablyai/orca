import { z } from 'zod'
import {
  BRIDGE_MAX_ROUTE_PARAM_CHARS,
  BRIDGE_MAX_ROUTE_PARAMS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_ROUTE_PATHNAME_PATTERN
} from './bridge-caps'

/**
 * Which screen the shell opened this page for.
 *
 * Additive, and optional where it is read for that reason: a shell built before C1.2 sends no
 * `route`, and the page says so rather than painting expo-router's Unmatched screen. It has to
 * cross, because the document is served at `/` and refuses every other path, so the page's own
 * location matches no route in the tree it carries and there is nothing else to derive it from.
 *
 * `params` is the search half, kept out of `pathname` so neither side has to parse a URL: the page
 * builds one, once, and writes it into its history before the first render.
 *
 * Its own module rather than the envelope's, because three other modules want the route without
 * the rest of the protocol: the native switches build one, the host holds one and republishes it
 * (ruling 33.1), and the page reads one back out of `init`.
 */
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
