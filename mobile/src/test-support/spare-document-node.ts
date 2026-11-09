// Alias the native spare pool for Vitest: no spare is ever parked, so every entry boots its own page.
export const prepareSpareDocument = (): Promise<boolean> => Promise.resolve(false)
export const claimSpareDocument = (): Promise<string | null> => Promise.resolve(null)
export const discardSpareDocument = (): Promise<void> => Promise.resolve()
