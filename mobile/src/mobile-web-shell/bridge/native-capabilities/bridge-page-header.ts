import * as z from 'zod'

/** The page's top bar drawn by the shell: the system nav bar on iOS, the Material top app bar on Android. */

/** Optional per route; without it (an older shell) the page draws its own bar. */
export const BRIDGE_PAGE_HEADER_GRANT = 'nativeHeader'

/**
 * Page to shell, a notify on that grant: the whole header as data, or null to hand the bar back.
 * Whole state rather than a diff, for the reason the Back claim is: a dropped frame cannot leave
 * the shell drawing a mix of two headers.
 */
export const BRIDGE_PAGE_HEADER_NOTIFY = 'page-header'

/**
 * Shell to page, a frame: one press on a header button or menu item, named by its id and the
 * revision of the header it was drawn from. A press must never run a handler for a header other
 * than the one that produced it, so the page drops one whose revision is no longer in effect.
 */
export const BRIDGE_PAGE_HEADER_ACTION_FRAME = 'headerAction'

/** The id a press on the shell's own Back carries when the native stack has nothing to pop. */
export const BRIDGE_PAGE_HEADER_BACK_ID = 'back'

/** The id a press on the title carries when the page made it a button. */
export const BRIDGE_PAGE_HEADER_TITLE_ID = 'title'

const MAX_ACTIONS = 4
const MAX_GROUPS = 8
const MAX_GROUP_ITEMS = 24

export const BridgePageHeaderIdSchema = z.string().min(1).max(160)
const labelSchema = z.string().min(1).max(200)
// A Lucide name from native-icon-symbols; the shell draws the label alone for one it does not know.
const iconSchema = z.string().min(1).max(64).optional()
// Hex only: the shell hands it straight to native colour props.
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
  .optional()

const menuActionSchema = z.strictObject({
  id: BridgePageHeaderIdSchema,
  label: labelSchema,
  icon: iconSchema,
  destructive: z.boolean().optional(),
  disabled: z.boolean().optional(),
  isOn: z.boolean().optional()
})

const menuItemSchema = z.union([
  menuActionSchema,
  z.strictObject({
    label: labelSchema,
    icon: iconSchema,
    submenu: z.array(menuActionSchema).min(1).max(MAX_GROUP_ITEMS)
  })
])

const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('button'),
    id: BridgePageHeaderIdSchema,
    label: labelSchema,
    icon: iconSchema,
    disabled: z.boolean().optional(),
    badge: z.number().int().min(1).max(999).optional(),
    tint: colorSchema
  }),
  z.strictObject({
    kind: z.literal('menu'),
    id: BridgePageHeaderIdSchema,
    label: labelSchema,
    icon: iconSchema,
    menu: z.array(z.array(menuItemSchema).max(MAX_GROUP_ITEMS)).max(MAX_GROUPS)
  })
])

// Required both ways: no build without it ever drew the header, so a frame lacking one is refused, never guessed at.
export const BridgePageHeaderRevisionSchema = z.number().int().nonnegative()

export const BridgePageHeaderContentSchema = z.strictObject({
  title: z.string().max(300),
  // False while the page's own title still shows in its content, as a collapsing title does.
  titleVisible: z.boolean(),
  back: z.boolean(),
  actions: z.array(actionSchema).max(MAX_ACTIONS),
  subtitle: z.strictObject({ text: z.string().max(300), dotColor: colorSchema }).optional(),
  // The title presses back as BRIDGE_PAGE_HEADER_TITLE_ID.
  titlePressable: z.boolean().optional()
})

// Stamped by the page on each header it sends, new per claim and per change, so ids are only read against it.
export const BridgePageHeaderSchema = BridgePageHeaderContentSchema.extend({
  revision: BridgePageHeaderRevisionSchema
})

export type BridgePageHeaderContent = z.infer<typeof BridgePageHeaderContentSchema>
export type BridgePageHeader = z.infer<typeof BridgePageHeaderSchema>
export type BridgePageHeaderAction = BridgePageHeader['actions'][number]
export type BridgePageHeaderMenuItem = z.infer<typeof menuItemSchema>
