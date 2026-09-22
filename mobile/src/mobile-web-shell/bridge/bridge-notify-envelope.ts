import { z } from 'zod'
import { BridgeErrorCaptureSchema } from './bridge-error-capture'
import { BRIDGE_HAPTICS_NOTIFY_FIELDS } from './bridge-haptics-notify'
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

/**
 * Every one-way page-to-shell frame, as one closed union.
 *
 * Its own module because it is the half of the envelope that grows: a notify is what a page uses
 * to tell the shell something it is owed no answer to, and each new one is a member here, a row in
 * `bridge-notify-grants.ts` and a branch in the host. Closed on purpose in all three places — a
 * name no shell implements is refused whole rather than half-served, which is what makes the
 * page's own `grants` check the thing that keeps a newer page quiet on an older shell.
 */
export const BridgeNotifySchema = z.discriminatedUnion('name', [
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal('foreground'),
    reason: z.enum(BRIDGE_FOREGROUND_NUDGE_REASONS).optional()
  }),
  // Behind the `navigate` grant, and that is not a convention: this union is closed, so an older
  // shell refuses the whole frame as `unrecognised-message`. The page checks `grants.native`
  // before it posts, which is what a grant is for.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal('navigate'),
    href: z.string().min(1).max(BRIDGE_MAX_ROUTE_HREF_CHARS).regex(BRIDGE_ROUTE_HREF_PATTERN)
  }),
  // Behind the same `navigate` grant, and carrying no target: the shell pops what it pushed, and
  // a page naming where to go back to would be naming a screen it cannot see.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_NAVIGATE_BACK_NOTIFY)
  }),
  // Behind the `externalLink` grant. The URL is held to the same three schemes on both sides: the
  // page refuses at the call site so a tap knows it went nowhere, and this refuses the frame so a
  // page that did not check is still held to it.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_EXTERNAL_LINK_GRANT),
    url: z.string().min(1).max(BRIDGE_MAX_EXTERNAL_LINK_CHARS).refine(isBridgeExternalLinkUrl)
  }),
  // Behind the `storage` grant, for the same reason `navigate` is behind its own.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal('storage'),
    key: z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey),
    /** Null removes it, which is what `AsyncStorage.removeItem` does. */
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
    /** The capture an `error` frame already carries, so both directions share one bound and one
     *  reader. Nothing is owed back: the page is telling the shell, not asking it. */
    error: BridgeErrorCaptureSchema
  }),
  // Behind the `haptics` grant, and the fields are its own module's for the reason stated there.
  z.object({ v: versionSchema, ...BRIDGE_HAPTICS_NOTIFY_FIELDS }),
  // The reader erasing its own request (ruling 34). Ungranted, because it can only spend
  // something this shell put on the route: the param is closed to the one the shell hands over,
  // and the value is what the page applied — a shell holding a newer one ignores the frame.
  z.object({
    v: versionSchema,
    type: z.literal('notify'),
    name: z.literal(BRIDGE_ROUTE_PARAM_CLEAR),
    param: z.enum(BRIDGE_CLEARABLE_ROUTE_PARAMS),
    value: z.string().min(1).max(BRIDGE_MAX_ROUTE_PARAM_CHARS)
  })
])

export type BridgeNotifyMessage = z.infer<typeof BridgeNotifySchema>
