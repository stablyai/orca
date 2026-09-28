import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { activateOrcaTerminalUnicodeProvider } from '../../src/shared/terminal-unicode-provider.ts'
import {
  buildAgentTuiStreamOps,
  mulberry32,
  splitIntoRandomChunks
} from '../../src/shared/agent-tui-ansi-fuzz-stream.ts'
import { Terminal as EsmTerminal } from '@xterm/headless/lib-headless/xterm-headless.mjs'

const require = createRequire(import.meta.url)
const { Terminal: CjsTerminal } = require('@xterm/headless')
const { Unicode11Addon } = require('@xterm/addon-unicode11')

const terminals = []
afterEach(() => terminals.splice(0).forEach((terminal) => terminal.dispose()))

function createTerminal(Terminal, fast, opts = {}) {
  const t = new Terminal({ cols: 11, rows: 5, scrollback: 50, allowProposedApi: true, ...opts })
  terminals.push(t)
  t.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(t)
  const real = t._core.unicodeService._providers['orca-11-zwj']
  let calls = 0
  if (!fast) {
    t.unicode.register({
      version: 'ref',
      wcwidth: (c) => real.wcwidth(c),
      charProperties: (c, p) => real.charProperties(c, p)
    })
    t.unicode.activeVersion = 'ref'
  } else {
    const orig = real.charProperties.bind(real)
    real.charProperties = (c, p) => (calls++, orig(c, p))
  }
  return { t, calls: () => calls }
}

function snapshot(t) {
  const core = t._core
  const dump = (b) => ({
    x: b.x,
    y: b.y,
    ybase: b.ybase,
    ydisp: b.ydisp,
    rows: Array.from({ length: b.lines.length }, (_, i) => {
      const r = b.lines.get(i)
      return [Array.from(r._data), r._combined, r._extendedAttrs, r.isWrapped]
    })
  })
  return {
    normal: dump(core.buffers.normal),
    alt: dump(core.buffers.alt),
    active: core.buffers.active === core.buffers.alt,
    join: core._inputHandler._parser.precedingJoinState,
    links: [...core._oscLinkService._dataByLinkId].map(([id, e]) => [
      id,
      e.lines.map((m) => m.line)
    ])
  }
}

const EDGE =
  'abcdefghijk' + // exactly cols -> pending wrap
  'lmnop‍qrs‍\u{1F419}é~ \x7f\x1b[?7lxxxxxxxxxxxxxxx\x1b[?7h' +
  '\x1b[4hins\x1b[4l\x1b(0lqk\x1b(B\x1b]8;;u\x07L\x1b]8;;\x07tail­x' +
  '日本abc\x1b[3D\x1b[1;38;2;1;2;3mZZ\x1b[0m\x1b[5GAB\r\n'

describe.each([
  ['cjs', CjsTerminal],
  ['esm', EsmTerminal]
])('%s patched headless with real Orca provider', (_name, Terminal) => {
  it('uses a different provider when ASCII has custom width', () => {
    const { t } = createTerminal(Terminal, true)
    let calls = 0
    t.unicode.register({
      version: 'custom-ascii',
      wcwidth: () => 2,
      charProperties: () => {
        calls++
        return calls === 1 ? 2 : 4
      }
    })
    t.unicode.activeVersion = 'custom-ascii'
    t._core.writeSync('abc')
    expect(calls).toBe(3)
    expect(t._core.buffers.active.x).toBe(5)
  })

  it('takes the fast path for plain ASCII', () => {
    const fast = createTerminal(Terminal, true)
    fast.t._core.writeSync(`x${'a'.repeat(9)}`)
    expect(fast.calls()).toBeLessThan(3)
  })

  it.each([1, 3, 64])('edge stream matches reference at chunk %i', (size) => {
    const a = createTerminal(Terminal, true)
    const b = createTerminal(Terminal, false)
    const s = EDGE.repeat(4)
    for (let i = 0; i < s.length; i += size) {
      a.t._core.writeSync(s.slice(i, i + size))
      b.t._core.writeSync(s.slice(i, i + size))
      expect(snapshot(a.t)).toEqual(snapshot(b.t))
    }
    a.t.resize(4, 7)
    b.t.resize(4, 7)
    a.t._core.writeSync(s)
    b.t._core.writeSync(s)
    expect(snapshot(a.t)).toEqual(snapshot(b.t))
  })

  it.each([1, 4, 64])('IRM over content and multi-line OSC 8 match at chunk %i', (size) => {
    const a = createTerminal(Terminal, true)
    const b = createTerminal(Terminal, false)
    const s =
      'abcdefghij\rXY\x1b[4hPQRS\x1b[4l\r\n' +
      '\x1b]8;;https://example.org\x07link text that wraps across rows\x1b]8;;\x07\r\n'
    for (const input of [s, s.repeat(8)]) {
      for (let i = 0; i < input.length; i += size) {
        a.t._core.writeSync(input.slice(i, i + size))
        b.t._core.writeSync(input.slice(i, i + size))
      }
      expect(snapshot(a.t)).toEqual(snapshot(b.t))
    }
  })

  it('screenReaderMode output matches', () => {
    const a = createTerminal(Terminal, true, { screenReaderMode: true })
    const b = createTerminal(Terminal, false, { screenReaderMode: true })
    const ca = []
    const cb = []
    a.t._core._inputHandler.onA11yChar((c) => ca.push(c))
    b.t._core._inputHandler.onA11yChar((c) => cb.push(c))
    a.t._core.writeSync(EDGE)
    b.t._core.writeSync(EDGE)
    expect(ca).toEqual(cb)
    expect(snapshot(a.t)).toEqual(snapshot(b.t))
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('agent TUI fuzz seed %i matches', (seed) => {
    const rng = mulberry32(seed)
    const dims = { cols: 11, rows: 5 }
    const ops = buildAgentTuiStreamOps(rng, dims, {
      includeMouseModes: true,
      includeOscHyperlinks: true,
      opCount: 400
    })
    const a = createTerminal(Terminal, true, dims)
    const b = createTerminal(Terminal, false, dims)
    for (const chunk of splitIntoRandomChunks(rng, ops.join(''), { minLen: 1, maxLen: 40 })) {
      a.t._core.writeSync(chunk)
      b.t._core.writeSync(chunk)
    }
    expect(snapshot(a.t)).toEqual(snapshot(b.t))
  })
})
