/**
 * Native half: the system font until the app bundles Geist, because an unregistered family is an
 * error on iOS rather than a fallback.
 */
export const fontFamilies: { sans: { fontFamily?: string } } = { sans: {} }
