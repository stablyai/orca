import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
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
const draws = (source) => {
  const ran = spawnSync('node', [join(import.meta.dirname, 'render.mjs')], {
    input: source,
    encoding: 'utf8'
  })

  assert.equal(ran.status, 0, `${source}\n${ran.stderr}`)
  assert.ok(JSON.parse(ran.stdout).width > 0, source)
}

test('a diagram that opens with frontmatter is drawn without it', () => {
  draws('---\nconfig:\n  theme: dark\n---\nxychart-beta\n  x-axis [Jan, Feb]\n  line [1, 2]')
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

test('every diagram type the Diagrams note names is drawn', () => {
  // The note as Claude reads it: in the hooks module, not a copy.
  const hooks = readFileSync(join(import.meta.dirname, '..', 'hooks', 'blocks.ts'), 'utf8')
  const types = /Use only these types, the rest do not render: ([^.]+)\./
    .exec(hooks)?.[1]
    .split(', ')

  assert.deepEqual(types?.toSorted(), Object.keys(SAMPLES).toSorted())
  Object.values(SAMPLES).forEach(draws)
})

test('an init directive, a comment and a line break in a label are drawn', () => {
  draws('%%{init: {"theme": "dark"}}%%\nflowchart LR\n  %% a comment\n  A[one<br/>two] --> B')
  draws('sequenceDiagram\n  A->>B: one<br/>two')
})
