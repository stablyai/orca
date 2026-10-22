/** @param {string} url */
export function terminalNerdFontCss(url) {
  return [
    '@font-face{',
    "font-family:'Orca Nerd Font Symbols';",
    `src:url('${url}') format('woff2');`,
    'font-weight:400;',
    'font-style:normal;',
    'font-display:swap;',
    'unicode-range:U+E000-F8FF,U+F0000-FFFFD,U+100000-10FFFD;',
    '}'
  ].join('')
}
