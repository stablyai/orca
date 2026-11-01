import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { verifyRendererBootGraph } from './renderer-boot-graph.mjs'

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])('reports both boot guards independently (two-byte=%s, payload=%s)', (twoByte, payload) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-boot-guards-'))
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const renderer = join(root, 'out', 'renderer')
    const i18n = join(root, 'src', 'renderer', 'src', 'i18n')
    mkdirSync(join(renderer, 'assets'), { recursive: true })
    mkdirSync(join(i18n, 'locales'), { recursive: true })
    writeFileSync(join(i18n, 'locales', 'en.json'), JSON.stringify({ pruned: 'x'.repeat(50) }))
    writeFileSync(join(i18n, 'en-runtime-required.json'), '{}')
    writeFileSync(
      join(renderer, 'index.html'),
      '<script type="module" src="/assets/index.js"></script>'
    )
    writeFileSync(
      join(renderer, 'assets', 'index.js'),
      JSON.stringify(`${twoByte ? '\u2014' : ''}${payload ? 'WebGL2 not supported' : ''}`)
    )

    expect(verifyRendererBootGraph(root)).toBe(twoByte || payload ? 1 : 0)
    const output = errors.mock.calls.flat().join('\n')
    expect(output.includes('Boot chunks contain chars above U+00FF')).toBe(twoByte)
    expect(output.includes('@xterm/addon-webgl -> index.js')).toBe(payload)
  } finally {
    errors.mockRestore()
    log.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
