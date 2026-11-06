import { z } from 'zod'
import { BridgeErrorCaptureSchema } from './bridge-error-capture'
import { BRIDGE_HAPTICS_NOTIFY_FIELDS } from './bridge-haptics-notify'
import { BRIDGE_LIVENESS_PROBE_NOTIFY_FIELDS } from './bridge-liveness-probe-notify'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge-page-back'
import { BRIDGE_PAGE_LOCATION } from './bridge-page-location'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import {
  BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY,
  BridgeTerminalToolbarSchema
} from './bridge-terminal-key'
import { BRIDGE_CLEARABLE_ROUTE_PARAMS, BRIDGE_ROUTE_PARAM_CLEAR } from './bridge-route-update'
import {
  isPageStorageKey,
  PAGE_STORAGE_MAX_KEY_CHARS,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../page-storage-keys'
import {
  BRIDGE_MAX_EXTERNAL_LINK_CHARS,
  BRIDGE_MAX_ROUTE_HREF_CHARS,
  BRIDGE_MAX_ROUTE_PARAM_CHARS,
  BRIDGE_MAX_VIEWPORT_COLS,
  BRIDGE_MAX_VIEWPORT_ROWS,
  BRIDGE_ROUTE_HREF_PATTERN,
  isBridgeExternalLinkUrl
} from './bridge-caps'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_FOREGROUND_NUDGE_REASONS,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  versionSchema
} from './bridge-frame-fields'

// Keep notify names closed and paired with grant checks/handlers; older shells reject unknown names, so newer pages must check grants before posting.
export const BridgeNotifySchema = z.discriminatedUnion('name', [
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal('foreground'),
    reason: z.enum(BRIDGE_FOREGROUND_NUDGE_REASONS).optional()
  }),
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal('navigate'),
    href: z.string().min(1).max(BRIDGE_MAX_ROUTE_HREF_CHARS).regex(BRIDGE_ROUTE_HREF_PATTERN),
    // Older shells strip this key and push, which is what every navigate did before it existed.
    replace: z.literal(true).optional()
  }),
  // Back carries no target; only the native stack knows what screen it will reveal.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_NAVIGATE_BACK_NOTIFY)
  }),
  // Check external-link schemes at both page call and envelope: callers need local refusal and unchecked pages must still be fenced.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_EXTERNAL_LINK_GRANT),
    url: z.string().min(1).max(BRIDGE_MAX_EXTERNAL_LINK_CHARS).refine(isBridgeExternalLinkUrl)
  }),
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal('storage'),
    key: z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey),
    value: z.string().max(PAGE_STORAGE_MAX_VALUE_CHARS).nullable()
  }),
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal('terminalViewport'),
    terminal: z.string().min(1),
    cols: z.number().int().min(1).max(BRIDGE_MAX_VIEWPORT_COLS),
    rows: z.number().int().min(1).max(BRIDGE_MAX_VIEWPORT_ROWS)
  }),
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_FAULT_GRANT),
    // Share error capture bounds in both directions; this fault report owes no reply.
    error: BridgeErrorCaptureSchema
  }),
  z.object({ v: versionSchema, ...BRIDGE_HAPTICS_NOTIFY_FIELDS }),
  z.object({ v: versionSchema, ...BRIDGE_LIVENESS_PROBE_NOTIFY_FIELDS }),
  // Allow only the shell-provided one-shot param; its holder ignores a clear naming an older value (ruling 34).
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_ROUTE_PARAM_CLEAR),
    param: z.enum(BRIDGE_CLEARABLE_ROUTE_PARAMS),
    value: z.string().min(1).max(BRIDGE_MAX_ROUTE_PARAM_CHARS)
  }),
  // Paint describes the page itself, so needs no grant; the shell waits only when ready declared reporting support.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_PAGE_PAINTED)
  }),
  // Back claims describe document state, not capability; send whole state so a dropped frame cannot invert future claims.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_BACK_CLAIM_NOTIFY),
    claimed: z.boolean()
  }),
  // Pages from desktops released with #34484 navigate inside their own document and report where, so a fold can reopen it natively.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_PAGE_LOCATION),
    href: z.string().min(1).max(BRIDGE_MAX_ROUTE_HREF_CHARS).regex(BRIDGE_ROUTE_HREF_PATTERN)
  }),
  // Behind the `terminalKeyRail` grant, which is what keeps it off a shell that has no rail. Whole
  // state rather than a toggle, for the reason the Back claim is.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY),
    claimed: z.boolean(),
    inputOwner: z.string().min(1).max(128).optional(),
    toolbar: BridgeTerminalToolbarSchema.optional()
  })
])

export type BridgeNotifyMessage = z.infer<typeof BridgeNotifySchema>
