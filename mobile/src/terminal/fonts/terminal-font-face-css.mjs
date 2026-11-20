/**
 * @param {string} family
 * @param {string} url
 * @param {string} unicodeRange
 * @param {string} [weight]
 */
function terminalFontFaceCss(family, url, unicodeRange, weight = '400') {
  return [
    '@font-face{',
    `font-family:'${family}';`,
    `src:url('${url}') format('woff2');`,
    `font-weight:${weight};`,
    'font-style:normal;',
    'font-display:swap;',
    `unicode-range:${unicodeRange};`,
    '}'
  ].join('')
}

/** @param {string} url */
export function terminalNerdFontCss(url) {
  return terminalFontFaceCss(
    'Orca Nerd Font Symbols',
    url,
    'U+E000-F8FF,U+F0000-FFFFD,U+100000-10FFFD'
  )
}

// Noto Sans Symbols 2 subset: Android ships no font with ⏴⏵⏶⏷ (Claude Code's ⏵⏵ mode marker).
/** @param {string} url */
export function terminalSymbolsFontCss(url) {
  return terminalFontFaceCss('Orca Terminal Symbols', url, 'U+23F4-23F7')
}

// Google Fonts' latin and latin-ext subsets; anything else falls through to the system mono stack.
const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

/** Variable fonts shipped with Orca, keyed by the id the terminal font setting stores. */
export const TERMINAL_BUNDLED_FONTS = /** @type {const} */ ({
  'jetbrains-mono': { family: 'JetBrains Mono', weights: '100 800', file: 'JetBrainsMono' },
  'fira-code': { family: 'Fira Code', weights: '300 700', file: 'FiraCode' },
  'geist-mono': { family: 'Geist Mono', weights: '100 900', file: 'GeistMono' }
})

/**
 * @param {keyof typeof TERMINAL_BUNDLED_FONTS} id
 * @param {{ latin: string, latinExt: string }} urls
 */
export function terminalBundledFontCss(id, urls) {
  const { family, weights } = TERMINAL_BUNDLED_FONTS[id]
  return (
    terminalFontFaceCss(family, urls.latinExt, LATIN_EXT_RANGE, weights) +
    terminalFontFaceCss(family, urls.latin, LATIN_RANGE, weights)
  )
}
