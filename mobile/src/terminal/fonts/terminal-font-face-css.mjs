/**
 * @param {string} family
 * @param {string} url
 * @param {string} unicodeRange
 */
function terminalFontFaceCss(family, url, unicodeRange) {
  return [
    '@font-face{',
    `font-family:'${family}';`,
    `src:url('${url}') format('woff2');`,
    'font-weight:400;',
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
