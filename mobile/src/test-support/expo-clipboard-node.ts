// Alias the native-only clipboard module to an empty pasteboard for Vitest, so host surfaces that
// offer Copy need no per-test mock; tests that check writes still mock it themselves.
export const setStringAsync = (_value: string): Promise<boolean> => Promise.resolve(true)
export const getStringAsync = (): Promise<string> => Promise.resolve('')
export const getImageAsync = (_options?: unknown): Promise<null> => Promise.resolve(null)
export const hasStringAsync = (): Promise<boolean> => Promise.resolve(false)
export const hasImageAsync = (): Promise<boolean> => Promise.resolve(false)
