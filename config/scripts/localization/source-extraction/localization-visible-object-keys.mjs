const USER_VISIBLE_OBJECT_KEYS = new Set([
  'accessibilityHint',
  'accessibilityLabel',
  'ariaLabel',
  'badge',
  'description',
  'emptyText',
  'error',
  'headerTitle',
  'helperText',
  'keywords',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'title',
  'toggleDescription',
  'tooltip'
])
const NATIVE_DIALOG_OBJECT_KEYS = new Set([
  'detail',
  'buttons',
  'body',
  'buttonLabel',
  'checkboxLabel'
])

export function isVisibleObjectKey(name, includeNativeDialogFields) {
  return (
    USER_VISIBLE_OBJECT_KEYS.has(name) ||
    (includeNativeDialogFields && NATIVE_DIALOG_OBJECT_KEYS.has(name))
  )
}
