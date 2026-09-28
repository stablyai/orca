import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))

// xterm is the only measurer of the cell box. These are the ways to measure a glyph without it,
// matched by technique rather than by name, so a rename cannot hide one. xterm's own code is the
// generated engine, which the walk leaves out.
const GLYPH_MEASUREMENT: [string, RegExp][] = [
  ['canvas text metrics', /\bmeasureText\s*\(/],
  ['offscreen canvas', /\bOffscreenCanvas\b/],
  ['font bounding box', /\b(font|actual)BoundingBox(Ascent|Descent|Left|Right)\b/]
]
// A probe span: a created span, a run of one glyph, and its laid-out width, all in one file.
const PROBE_SPAN = [
  /createElement\(\s*['"`]span['"`]\s*\)/,
  /['"`][A-Za-z0-9]['"`]\s*\.repeat\s*\(/,
  /\b(offsetWidth|getBoundingClientRect)\b/
]

function productSources(): { path: string; text: string }[] {
  return censusSourceFiles(SOURCE_ROOT)
    .map((path) => ({ path, name: relative(SOURCE_ROOT, path).replaceAll('\\', '/') }))
    .filter(({ name }) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map(({ path, name }) => ({ path: name, text: readFileSync(path, 'utf8') }))
}

function glyphMeasurements(text: string): string[] {
  const found = GLYPH_MEASUREMENT.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind)
  return PROBE_SPAN.every((pattern) => pattern.test(text)) ? [...found, 'probe span'] : found
}

describe('the cell box has one measurer', () => {
  it('walks the product sources, including the document that reports the box', () => {
    const paths = productSources().map((source) => source.path)
    expect(paths).toContain('terminal/document/laid-out-cell-box.ts')
    expect(paths).toContain('terminal/document/terminal-init.ts')
  })

  it('recognises each technique it fences', () => {
    expect(glyphMeasurements("ctx.measureText('W')")).toEqual(['canvas text metrics'])
    expect(glyphMeasurements('new OffscreenCanvas(1, 1)')).toEqual(['offscreen canvas'])
    expect(glyphMeasurements('m.fontBoundingBoxAscent + m.fontBoundingBoxDescent')).toEqual([
      'font bounding box'
    ])
    expect(
      glyphMeasurements(
        "const s = document.createElement('span'); s.textContent = 'W'.repeat(32); s.offsetWidth"
      )
    ).toEqual(['probe span'])
  })

  it('has no file under mobile/src measure a glyph outside xterm', () => {
    const found = productSources().flatMap(({ path, text }) =>
      glyphMeasurements(text).map((kind) => `${path}: ${kind}`)
    )
    expect(found).toEqual([])
  })
})
