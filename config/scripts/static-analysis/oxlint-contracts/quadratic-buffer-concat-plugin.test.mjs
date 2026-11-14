import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/quadratic-buffer-concat.mjs')

function lintSources(sources) {
  return runOxlintPluginOnSources({
    pluginName: 'quadratic-buffer-concat',
    pluginPath,
    sources,
    extension: 'ts',
    rules: {
      'quadratic-buffer-concat/no-loop-carried-concat': 'warn'
    }
  })
}

const violations = [
  [
    'escaped computed concat',
    String.raw`let acc = Buffer.alloc(0); for (const chunk of chunks) { acc = Buffer['con\x63at']([acc, chunk]) }`,
    'acc'
  ],
  [
    'indirect stream carry',
    `async function read(stream) {
       let remainder = null
       for await (const chunk of stream) {
         const data = remainder ? Buffer.concat([remainder, chunk]) : chunk
         remainder = Buffer.from(data.subarray(lineStart))
       }
     }`,
    'remainder'
  ],
  [
    'classic for initializer',
    'for (let acc = Buffer.alloc(0), i = 0; i < n; i++) { acc = Buffer.concat([acc, chunks[i]]) }',
    'acc'
  ],
  [
    'class field accumulator',
    'class Reader { read() { while (this.open) { this.pending = Buffer.concat([this.pending, chunk]) } } }',
    'this.pending'
  ]
]

const accepted = [
  [
    'spread chunk list',
    `let carryChunks = []
     while (scanEnd > 0) {
       const region = carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
       carryChunks = [buffer.subarray(0, firstNewline)]
     }`
  ],
  [
    'iteration-local accumulator',
    'for (const chunk of chunks) { let framed = HEADER; framed = Buffer.concat([framed, chunk]); send(framed) }'
  ],
  [
    'no enclosing loop',
    'class S { handle(chunk) { const buffer = Buffer.concat([this.pending, chunk]); this.pending = parse(buffer).pending } }'
  ]
]

const diagnosticsBySource = new Map()
beforeAll(() => {
  const sources = [...violations, ...accepted].map(([, source]) => source)
  lintSources(sources).forEach((diagnostics, index) => {
    diagnosticsBySource.set(sources[index], diagnostics)
  })
})

describe('quadratic Buffer.concat Oxlint plugin', () => {
  it.each(violations)('reports %s', (_name, source, accumulator) => {
    const diagnostics = diagnosticsBySource.get(source)

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].message).toContain(accumulator)
  })

  it.each(accepted)('accepts %s', (_name, source) => {
    expect(diagnosticsBySource.get(source)).toEqual([])
  })
})
