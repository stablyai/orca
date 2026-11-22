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

/** Shell to page, a frame: one press on a header button or menu item, named by its id. */
export const BRIDGE_PAGE_HEADER_ACTION_FRAME = 'headerAction'

/** The id a press on the shell's own Back carries when the native stack has nothing to pop. */
export const BRIDGE_PAGE_HEADER_BACK_ID = 'back'

const MAX_ACTIONS = 4
const MAX_GROUPS = 8
const MAX_GROUP_ITEMS = 24

export const BridgePageHeaderIdSchema = z.string().min(1).max(160)
const labelSchema = z.string().min(1).max(200)
// A Lucide name from native-icon-symbols; the shell draws the label alone for one it does not know.
const iconSchema = z.string().min(1).max(64).optional()

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
    disabled: z.boolean().optional()
  }),
  z.strictObject({
    kind: z.literal('menu'),
    id: BridgePageHeaderIdSchema,
    label: labelSchema,
    icon: iconSchema,
    menu: z.array(z.array(menuItemSchema).max(MAX_GROUP_ITEMS)).max(MAX_GROUPS)
  })
])

export const BridgePageHeaderSchema = z.strictObject({
  title: z.string().max(300),
  // False while the page's own title still shows in its content, as a collapsing title does.
  titleVisible: z.boolean(),
  back: z.boolean(),
  actions: z.array(actionSchema).max(MAX_ACTIONS)
})

export type BridgePageHeader = z.infer<typeof BridgePageHeaderSchema>
export type BridgePageHeaderAction = BridgePageHeader['actions'][number]
export type BridgePageHeaderMenuItem = z.infer<typeof menuItemSchema>
