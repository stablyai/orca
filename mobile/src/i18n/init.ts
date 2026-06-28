// Why: declared here so `storage/preferences.ts` can import the canonical
// `MobileUiLanguage` type without coupling to the rest of the i18n runtime.
// Task 4 will fill in the i18next bootstrap alongside this same export.
export type MobileUiLanguage = 'system' | 'en' | 'zh'
