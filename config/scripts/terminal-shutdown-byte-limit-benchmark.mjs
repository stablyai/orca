import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import ts from 'typescript-api'
import { build } from 'esbuild'

// Pipe the baseline capture module on stdin. No Electron or visible terminal is launched.
const renderer = path.resolve('src/renderer/src')
const entry = path.join(renderer, 'components/terminal-pane/terminal-shutdown-layout-capture.ts')
const sources = [readFileSync(0, 'utf8'), readFileSync(entry, 'utf8')]
assert(sources.every((source) => source.includes('export function captureTerminalShutdownLayout')))
const layoutFile = path.join(renderer, 'components/terminal-pane/layout-serialization.ts')
const layoutSource = readFileSync(layoutFile, 'utf8')
const layoutAst = ts.createSourceFile(layoutFile, layoutSource, ts.ScriptTarget.Latest, true)
const layoutNames = ['getLayoutChildNodes', 'serializePaneTree', 'serializeTerminalLayout']
const layoutFunctions = layoutAst.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && layoutNames.includes(node.name?.text)
)
assert.equal(layoutFunctions.length, layoutNames.length)
const layoutSubset = `import { isTerminalLeafId } from '../../../../shared/stable-pane-id';
${layoutFunctions.map((node) => node.getText(layoutAst)).join('\n')}`

async function load(source) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    alias: { '@': renderer },
    plugins: [
      {
        name: 'capture-benchmark',
        setup(builder) {
          builder.onLoad({ filter: /terminal-shutdown-layout-capture\.ts$/ }, () => ({
            contents: `${source}\nexport { fitsSessionScrollbackByteLimit, MAX_BUFFER_BYTES };`,
            loader: 'ts',
            resolveDir: path.dirname(entry)
          }))
          // Select unchanged layout declarations to exclude unrelated renderer module side effects.
          builder.onLoad({ filter: /[/\\]layout-serialization\.ts$/ }, () => ({
            contents: layoutSubset,
            loader: 'ts',
            resolveDir: path.dirname(layoutFile)
          }))
          builder.onResolve({ filter: /pane-terminal-output-scheduler$/ }, () => ({
            path: 'capture-scheduler',
            namespace: 'fixture'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export function flushTerminalOutput(terminal) { terminal.recordFlush?.(); }',
            loader: 'js'
          }))
        }
      }
    ]
  })
  const bundled = `${result.outputFiles[0].text}\n//# sourceURL=shutdown-byte-limit-benchmark-bundle.js`
  return import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)
}
const modules = await Promise.all(sources.map(load))
const captures = modules.map((module) => module.captureTerminalShutdownLayout)
const predicates = modules.map((module) => module.fitsSessionScrollbackByteLimit)

class FixtureElement {
  constructor({ classes = [], dataset = {}, children = [], firstElementChild = null } = {}) {
    this.classList = { contains: (name) => classes.includes(name) }
    this.dataset = dataset
    this.children = children
    this.firstElementChild = firstElementChild
    this.style = { flex: '1' }
  }
}
globalThis.HTMLElement = FixtureElement

function leafId(index) {
  return `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`
}

function captureArgs(panes, captureBuffers = true, cleared = false) {
  const leaves = panes.map(
    (pane) =>
      new FixtureElement({
        classes: ['pane'],
        dataset: { leafId: pane.leafId }
      })
  )
  let root = leaves[0] ?? null
  for (const leaf of leaves.slice(1)) {
    root = new FixtureElement({ classes: ['pane-split', 'is-horizontal'], children: [root, leaf] })
  }
  const prior = Object.fromEntries(panes.map((pane) => [pane.leafId, 'prior-buffer']))
  return {
    manager: { getPanes: () => panes, getActivePane: () => panes[0] ?? null },
    container: new FixtureElement({ firstElementChild: root }),
    expandedPaneId: panes[1]?.id ?? null,
    paneTransports: new Map(
      panes.map((pane, index) => [
        pane.id,
        {
          getPtyId: () => (index % 2 ? null : `ssh:target@@pty-${index}`)
        }
      ])
    ),
    paneTitlesByPaneId: Object.fromEntries(panes.map((pane) => [pane.id, `title-${pane.id}`])),
    existingLayout: Object.freeze({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      buffersByLeafId: Object.freeze(prior),
      scrollbackRefsByLeafId: Object.freeze({ [leafId(0)]: 'v1-prior' }),
      ptyIdsByLeafId: Object.freeze({ [leafId(1)]: 'local-prior' })
    }),
    captureBuffers,
    clearedScrollbackLeafIds: new Set(cleared ? [leafId(0)] : [])
  }
}

function syntheticFixture(config) {
  const events = []
  const panes = config.units.map((unit, index) =>
    Object.freeze({
      id: index + 1,
      leafId: leafId(index),
      terminal: Object.freeze({
        options: { scrollback: config.rows },
        cols: 120,
        rows: 40,
        buffer: { active: { cursorX: index, cursorY: index } },
        recordFlush: () => events.push(['flush', index])
      }),
      serializeAddon: {
        serialize(options) {
          const rows = options?.scrollback ?? 0
          events.push(['serialize', index, rows])
          if (config.fail && index === 0) {
            throw new Error('fixture serializer failure')
          }
          return unit.repeat(Math.max(0, rows))
        }
      }
    })
  )
  return { args: captureArgs(panes, config.capture, config.cleared), events }
}

let seed = 0x17c0ffee
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return (seed >>> 8) % max
}
const limit = modules[0].MAX_BUFFER_BYTES
assert.equal(modules[1].MAX_BUFFER_BYTES, limit)
const units = ['x', 'é', '界', '😀', '\ud83d', '\udc00', '\x1b[31mtext\x1b[0m\r\n', '']
let comparisons = 0
function compareFixture(config) {
  const results = captures.map((capture) => {
    const fixture = syntheticFixture(config)
    const layout = capture(fixture.args)
    return { layout, events: fixture.events }
  })
  assert.deepEqual(results[1], results[0])
  comparisons++
}
for (const unit of units.filter(Boolean)) {
  for (let delta = -2; delta <= 2; delta++) {
    const rows = Math.floor((limit - 7) / Buffer.byteLength(unit)) + delta
    compareFixture({ units: [unit], rows, capture: true, cleared: false, fail: false })
  }
}
for (let iteration = 0; iteration < 1500; iteration++) {
  compareFixture({
    units: Array.from({ length: random(4) }, () => units[random(units.length)].repeat(random(50))),
    rows: random(2000),
    capture: random(5) !== 0,
    cleared: random(3) === 0,
    fail: random(9) === 0
  })
}
for (const unit of units) {
  for (const length of [0, 1, 64, limit - 1, limit, limit + 1]) {
    const input = unit.repeat(length)
    assert.equal(predicates[1](input), predicates[0](input))
  }
}
console.log(`${comparisons} full capture layouts/event traces and 48 byte-fit cases match`)

function sample(arm, input, repeats) {
  const start = performance.now()
  let output
  for (let i = 0; i < repeats; i++) {
    output = arm(input)
  }
  return { elapsed: (performance.now() - start) / repeats, output }
}

function benchmark(name, input, arms, minimumRepeats = 1) {
  const expected = arms[0](input)
  assert.deepEqual(arms[1](input), expected)
  for (const arm of arms) {
    const until = performance.now() + 250
    while (performance.now() < until) {
      sample(arm, input, 1)
    }
  }
  const repeats = Math.max(
    minimumRepeats,
    Math.min(100000, Math.ceil(50 / sample(arms[0], input, 1).elapsed))
  )
  /** @type {number[][]} */
  const times = [[], []]
  for (let pair = 0; pair < 8; pair++) {
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      const result = sample(arms[index], input, repeats)
      times[index].push(result.elapsed)
      assert.deepEqual(result.output, expected)
    }
  }
  const median = times.map((values) => {
    values.sort((a, b) => a - b)
    return (values[3] + values[4]) / 2
  })
  console.log(JSON.stringify({ name, repeats, median, times }))
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pairs: 8,
    unit: 'ms'
  })
)
for (const size of [64, 32768, limit, 2 * 1024 * 1024]) {
  benchmark(`fit ASCII ${size} code units`, 'x'.repeat(size), predicates)
  benchmark(`fit Unicode ${size} code units`, '界'.repeat(size), predicates)
}

const xterm = await import('@xterm/headless')
const addon = await import('@xterm/addon-serialize')
const Terminal = xterm.Terminal ?? xterm.default.Terminal
const SerializeAddon = addon.SerializeAddon ?? addon.default.SerializeAddon
for (const [rows, unicode, paneCount] of [
  [50, false, 1],
  [500, false, 1],
  [5000, false, 1],
  [5000, true, 1],
  [500, false, 8]
]) {
  const panes = []
  for (let index = 0; index < paneCount; index++) {
    const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 5000, allowProposedApi: true })
    const serializeAddon = new SerializeAddon()
    terminal.loadAddon(serializeAddon)
    const row = unicode ? '界é😀'.repeat(15) : 'line x'.repeat(18)
    await new Promise((resolve) => terminal.write(`${row}\r\n`.repeat(rows), resolve))
    panes.push({ id: index + 1, leafId: leafId(index), terminal, serializeAddon })
  }
  try {
    benchmark(
      `full capture ${paneCount} panes / ${rows} ${unicode ? 'Unicode' : 'ASCII'} lines`,
      captureArgs(panes),
      captures,
      4
    )
  } finally {
    panes.forEach((pane) => pane.terminal.dispose())
  }
}
