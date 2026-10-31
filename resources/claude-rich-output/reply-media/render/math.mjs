// Usage: node math.mjs < formula.tex
// Typesets LaTeX math (no delimiters) in display style and prints the same
// line as render.mjs. MathJax draws the SVG, so no LaTeX install is needed.
import { readFileSync } from 'node:fs'

import { THEME, ZOOM, cached, rasterize } from './render.mjs'

// CSS px per ex, the unit MathJax sizes its SVG in. At the hooks' 8 px per
// terminal column JetBrains Mono's x is 7.3 px tall, so at 7 a formula's
// letters are about as tall as the text around it, and its x is 9 px wide.
const EX = 7

const source = readFileSync(0, 'utf8')
const key = JSON.stringify(['math-xml-v3', THEME.fg, THEME.bg, EX, ZOOM]) + source
const previous = cached(key)
if (previous) {
  console.log(JSON.stringify(previous))
} else {
  const { default: MathJax } = await import('@mathjax/src')
  await MathJax.init({
    loader: { load: ['input/tex', 'output/svg'] },
    tex: {
      // MathJax draws a mistake and succeeds: an unknown macro in red, any
      // other in an error box. Both fail here instead.
      packages: { '[-]': ['noundefined'] },
      formatError: (_, error) => {
        throw new Error(error.message)
      }
    }
  })
  const node = await MathJax.tex2svgPromise(source, { display: true })
  // librsvg consumes XML, while innerHTML uses HTML attribute escaping. TeX
  // metadata (notably cases containing < or &) must be XML-escaped too.
  const adaptor = MathJax.startup.adaptor
  const svg = adaptor.serializeXML(adaptor.firstChild(node))
  // shortcut: a formula with a \tag or \notag is not drawn. MathJax makes it as
  // wide as its page and librsvg, having none, draws nothing; size the SVG by
  // its min-width if tags start to matter.
  if (svg.includes('width="100%"')) {
    throw new Error('a \\tag has no width without a page')
  }

  // librsvg takes an ex as 6 px whatever the font and currentColor as black, so
  // both are resolved here.
  rasterize(
    svg
      .replaceAll('currentColor', THEME.fg)
      .replace(/(width|height)="([\d.]+)ex"/g, (_, side, ex) => `${side}="${ex * EX}"`),
    key
  )
}
