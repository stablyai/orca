import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { flatten, withModelOrder } from './render.mjs'

test('a loop is drawn in the order its nodes are written', async () => {
  registerHooks({ load: withModelOrder })
  const { renderMermaidSVG } = await import('beautiful-mermaid')
  // A retry loop, which ELK's default cycle breaker draws as start → ok? → try,
  // and a workflow that returns to its start, which a greedy one starts at review.
  const graphs = [
    [
      'flowchart LR\n  S[start] --> A[try]\n  A --> B{ok?}\n  B -->|no| A\n  B -->|yes| C[done]',
      ['start', 'try', 'ok\\?', 'done']
    ],
    [
      'flowchart LR\n  A[main] --> B[branch] --> C[commit] --> R{review}\n  R -->|changes| C\n  R -->|ok| M[merge] --> A',
      ['main', 'branch', 'commit', 'review', 'merge']
    ]
  ]
  for (const [source, labels] of graphs) {
    const svg = renderMermaidSVG(source)
    const xs = labels.map((label) =>
      Number(new RegExp(`<text[^>]*x="([\\d.]+)"[^>]*>${label}<`).exec(svg)?.[1])
    )

    assert.ok(xs.every(Number.isFinite), `every label found: ${xs}`)
    assert.deepEqual(
      xs,
      [...xs].sort((a, b) => a - b),
      labels.join(' → ')
    )
  }
})

test('flatten resolves var() and color-mix() to hex and drops font imports', () => {
  const svg = `<svg style="--bg:#000000;--fg:#ffffff"><style>
  @import url('https://fonts.example/css2?family=Inter:wght@400;500&amp;display=swap');
  svg { --_line: var(--line, color-mix(in srgb, var(--fg) 50%, var(--bg))); }
</style><path stroke="var(--_line)" fill="color-mix(in srgb, #000 75%, #fff 25%)"/></svg>`
  const flat = flatten(svg)

  assert.match(flat, /stroke="#808080"/)
  assert.match(flat, /fill="#404040"/)
  assert.doesNotMatch(flat, /var\(|color-mix\(|@import/)
})

/** Runs render.mjs on `source` and asserts that it drew a picture. */
const draws = (source, entry = join(import.meta.dirname, 'render.mjs')) => {
  const ran = spawnSync('node', [entry], {
    input: source,
    encoding: 'utf8'
  })

  assert.equal(ran.status, 0, `${source}\n${ran.stderr}`)
  assert.ok(JSON.parse(ran.stdout).width > 0, source)
}

test('a diagram that opens with frontmatter is drawn without it', () => {
  draws('---\nconfig:\n  theme: dark\n---\nxychart-beta\n  x-axis [Jan, Feb]\n  line [1, 2]')
})

test('a cached diagram is reused without rasterizing it again', () => {
  const source = `flowchart LR\n A[cache ${process.pid}] --> B[reuse]`
  const draw = () =>
    spawnSync(process.execPath, [join(import.meta.dirname, 'render.mjs')], {
      input: source,
      encoding: 'utf8'
    })
  const first = draw()
  assert.equal(first.status, 0, first.stderr)
  const image = JSON.parse(first.stdout)
  try {
    const pixels = readFileSync(image.file)
    utimesSync(image.file, 1, 1)
    const again = draw()
    assert.equal(again.status, 0, again.stderr)
    assert.deepEqual(JSON.parse(again.stdout), image)
    assert.equal(statSync(image.file).mtimeMs, 1000)
    assert.deepEqual(readFileSync(image.file), pixels)
  } finally {
    rmSync(image.file, { force: true })
  }
})

// A small diagram of each type the Diagrams note lets Claude write.
const SAMPLES = {
  flowchart: 'flowchart LR\n  A --> B',
  'stateDiagram-v2': 'stateDiagram-v2\n  [*] --> A\n  A --> [*]',
  sequenceDiagram: 'sequenceDiagram\n  A->>B: hi',
  classDiagram: 'classDiagram\n  A <|-- B',
  erDiagram: 'erDiagram\n  A ||--o{ B : has',
  'xychart-beta': 'xychart-beta\n  x-axis [a, b]\n  bar [1, 2]'
}

test('the renderer runs through a symlinked plugin directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-render-link-'))
  try {
    const link = join(root, 'linked render')
    symlinkSync(import.meta.dirname, link, process.platform === 'win32' ? 'junction' : 'dir')
    draws(SAMPLES.flowchart, join(link, 'render.mjs'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every diagram type the Diagrams note names is drawn', () => {
  // The note as Claude reads it: in the hooks module, not a copy.
  const hooks = readFileSync(join(import.meta.dirname, '..', 'hooks', 'blocks.ts'), 'utf8')
  const types = /Use only these types, the rest do not render: ([^.]+)\./
    .exec(hooks)?.[1]
    .split(', ')

  assert.deepEqual(types?.toSorted(), Object.keys(SAMPLES).toSorted())
  Object.values(SAMPLES).forEach((source) => draws(source))
})

test('an init directive, a comment and a line break in a label are drawn', () => {
  draws('%%{init: {"theme": "dark"}}%%\nflowchart LR\n  %% a comment\n  A[one<br/>two] --> B')
  draws('sequenceDiagram\n  A->>B: one<br/>two')
})

const completePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=',
  'base64'
)
const zeroWidth = Buffer.from(completePng)
zeroWidth.writeUInt32BE(0, 16)
const zeroHeight = Buffer.from(completePng)
zeroHeight.writeUInt32BE(0, 20)

for (const [kind, source, entry] of [
  ['diagram', SAMPLES.flowchart, 'render.mjs'],
  ['formula', String.raw`x = \frac{a}{b}`, 'math.mjs']
]) {
  for (const { name, bytes } of [
    { name: 'partial header', bytes: completePng.subarray(0, 20) },
    { name: 'missing end', bytes: completePng.subarray(0, -12) },
    { name: 'zero width', bytes: zeroWidth },
    { name: 'zero height', bytes: zeroHeight }
  ]) {
    test(`a ${kind} rejects successful conversion with ${name} and can be retried`, () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-render-png-')))
      try {
        const preload = join(root, 'converter.cjs')
        writeFileSync(
          preload,
          `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  if (command === 'rsvg-convert') {
    const output = args[args.indexOf('--output') + 1];
    fs.writeFileSync(output, Buffer.from(${JSON.stringify(bytes.toString('hex'))}, 'hex'));
    return { status: 0, stdout: '', stderr: '' };
  }
  return original(command, args, ...rest);
};
require('node:module').syncBuiltinESMExports();
`
        )
        const invoke = (intercept) =>
          spawnSync(
            process.execPath,
            [...(intercept ? ['--require', preload] : []), join(import.meta.dirname, entry)],
            {
              input: source,
              encoding: 'utf8',
              env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, LOCALAPPDATA: root }
            }
          )
        const failed = invoke(true)
        assert.notEqual(failed.status, 0)
        assert.equal(failed.stdout, '')
        assert.match(failed.stderr, /conversion did not produce a complete PNG/)
        assert.deepEqual(
          readdirSync(root, { recursive: true }).filter((name) => /\.(?:png|tmp)$/.test(name)),
          []
        )
        const retried = invoke(false)
        assert.equal(retried.status, 0, retried.stderr)
        const image = JSON.parse(retried.stdout)
        assert.ok(image.width > 0 && image.height > 0)
        const pixels = readFileSync(image.file)
        const cached = invoke(true)
        assert.equal(cached.status, 0, cached.stderr)
        assert.deepEqual(JSON.parse(cached.stdout), image)
        assert.deepEqual(readFileSync(image.file), pixels)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
}
