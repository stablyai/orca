import geistUrl from '../../assets/fonts/Geist-Variable.woff2'

const STYLE_ELEMENT_ID = 'orca-page-fonts'

/** Plants the page's Geist face once; the variable file covers every weight the ramp uses. */
export function installPageFonts(doc: Document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = doc.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = [
    '@font-face{',
    "font-family:'Geist';",
    `src:url('${geistUrl}') format('woff2');`,
    'font-weight:100 900;',
    'font-style:normal;',
    'font-display:swap;',
    '}'
  ].join('')
  doc.head.appendChild(style)
}
