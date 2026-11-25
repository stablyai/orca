import * as z from 'zod'

// The page asks the shell to present a system alert, text prompt or pick-one list; page content stays web, the dialog is native.
// One verb with an action keeps every route within the grant ceiling. The shell shows one dialog at a time and refuses a second,
// so the page draws that one itself; a refusal of any kind means the page draws.
export const BRIDGE_DIALOG_VERB = 'native.dialog.act'

const MAX_TITLE_CHARS = 300
const MAX_MESSAGE_CHARS = 2000
const MAX_LABEL_CHARS = 100
export const BRIDGE_DIALOG_MAX_FIELD_CHARS = 4000
export const BRIDGE_DIALOG_MAX_PICK_OPTIONS = 500
const MAX_OPTION_CHARS = 300

// Page-chosen, so a late dismiss from a closed dialog cannot withdraw the next one.
const tokenSchema = z.string().min(1).max(64)
const titleSchema = z.string().min(1).max(MAX_TITLE_CHARS)
const messageSchema = z.string().max(MAX_MESSAGE_CHARS).optional()
const requiredLabelSchema = z.string().min(1).max(MAX_LABEL_CHARS)
const labelSchema = requiredLabelSchema.optional()

// React Native's keyboard kinds; closed so a shell never guesses at one it does not map.
export const BRIDGE_DIALOG_KEYBOARD_TYPES = [
  'default',
  'email-address',
  'numeric',
  'phone-pad',
  'number-pad',
  'decimal-pad',
  'visible-password',
  'ascii-capable',
  'numbers-and-punctuation',
  'url',
  'name-phone-pad',
  'twitter',
  'web-search',
  'ascii-capable-number-pad'
] as const

export const dialogConfirmParamsSchema = z.strictObject({
  action: z.literal('confirm'),
  token: tokenSchema,
  title: titleSchema,
  message: messageSchema,
  confirmLabel: labelSchema,
  // null drops Cancel, for a notice that only needs acknowledging.
  cancelLabel: requiredLabelSchema.nullable().optional(),
  destructive: z.boolean()
})

export const dialogPromptParamsSchema = z.strictObject({
  action: z.literal('prompt'),
  token: tokenSchema,
  title: titleSchema,
  message: messageSchema,
  defaultValue: z.string().max(BRIDGE_DIALOG_MAX_FIELD_CHARS),
  placeholder: z.string().max(MAX_LABEL_CHARS).optional(),
  submitLabel: labelSchema,
  cancelLabel: labelSchema,
  selectTextOnFocus: z.boolean(),
  allowEmpty: z.boolean(),
  keyboardType: z.enum(BRIDGE_DIALOG_KEYBOARD_TYPES).optional()
})

const pickOptionSchema = z.strictObject({
  value: z.string().max(MAX_OPTION_CHARS),
  label: z.string().max(MAX_OPTION_CHARS),
  subtitle: z.string().max(MAX_OPTION_CHARS).optional(),
  section: z.string().max(MAX_OPTION_CHARS).optional(),
  disabled: z.boolean()
})

export const dialogPickParamsSchema = z.strictObject({
  action: z.literal('pick'),
  token: tokenSchema,
  title: titleSchema,
  options: z.array(pickOptionSchema).min(1).max(BRIDGE_DIALOG_MAX_PICK_OPTIONS),
  selected: z.string().max(MAX_OPTION_CHARS),
  searchable: z.boolean()
})

// The page's own Back or unmount: close the dialog it opened under this token, if it is still the one showing.
const dialogDismissParamsSchema = z.strictObject({
  action: z.literal('dismiss'),
  token: tokenSchema
})

export const dialogShowParamsSchema = z.discriminatedUnion('action', [
  dialogConfirmParamsSchema,
  dialogPromptParamsSchema,
  dialogPickParamsSchema
])

export const dialogParamsSchema = z.discriminatedUnion('action', [
  dialogConfirmParamsSchema,
  dialogPromptParamsSchema,
  dialogPickParamsSchema,
  dialogDismissParamsSchema
])

export type BridgeDialogShowParams = z.infer<typeof dialogShowParamsSchema>
export type BridgeDialogParams = z.infer<typeof dialogParamsSchema>
export type BridgeDialogPickOption = z.infer<typeof pickOptionSchema>
export type BridgeDialogKeyboardType = (typeof BRIDGE_DIALOG_KEYBOARD_TYPES)[number]

// confirm: the primary button (with the field's text or the picked value); cancel: the Cancel button;
// dismiss: anything else that closed it (a swipe, the page leaving, another screen covering it).
export const BRIDGE_DIALOG_OUTCOMES = ['confirm', 'cancel', 'dismiss'] as const

export type BridgeDialogOutcome = (typeof BRIDGE_DIALOG_OUTCOMES)[number]

export const dialogShowResultSchema = z.strictObject({
  outcome: z.enum(BRIDGE_DIALOG_OUTCOMES),
  value: z.string().max(BRIDGE_DIALOG_MAX_FIELD_CHARS).nullable()
})

export const dialogDismissResultSchema = z.strictObject({ dismissed: z.boolean() })

export type BridgeDialogAnswer = z.infer<typeof dialogShowResultSchema>

export const dialogResultSchema = z.union([dialogShowResultSchema, dialogDismissResultSchema])
