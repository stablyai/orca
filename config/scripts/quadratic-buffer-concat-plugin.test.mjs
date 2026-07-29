import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runOxlintPluginOnSource } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/quadratic-buffer-concat.mjs')

function lintSource(source) {
  return runOxlintPluginOnSource({
    pluginName: 'quadratic-buffer-concat',
    pluginPath,
    source,
    extension: 'ts',
    rules: {
      'quadratic-buffer-concat/no-loop-carried-concat': 'warn'
    }
  })
}

const violations = [
  [
    'self accumulator',
    'let acc = Buffer.alloc(0); for (const chunk of chunks) { acc = Buffer.concat([acc, chunk]) }',
    'acc'
  ],
  [
    'trailing accumulator',
    'let acc = Buffer.alloc(0); for (const chunk of chunks) { acc = Buffer.concat([chunk, acc]) }',
    'acc'
  ],
  [
    'spread self accumulator',
    'let acc = Buffer.alloc(0); for (const chunk of chunks) { acc = Buffer.concat([...acc, chunk]) }',
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
    'indirect transcript carry',
    `function read(fd, size) {
       let carryBytes = Buffer.alloc(0)
       while (bytesRead < size) {
         const combined = Buffer.concat([buffer.subarray(0, n), carryBytes])
         carryBytes = combined.subarray(0, firstNewline)
       }
     }`,
    'carryBytes'
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
  ],
  [
    'guarded accumulator',
    'let acc = Buffer.alloc(0); while (open) { acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]) }',
    'acc'
  ]
]

const accepted = [
  [
    'single concat after loop',
    'const parts = []; for (const chunk of chunks) { parts.push(chunk) } const out = Buffer.concat(parts)'
  ],
  [
    'spread chunk list',
    `let carryChunks = []
     while (scanEnd > 0) {
       const region = carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
       carryChunks = [buffer.subarray(0, firstNewline)]
     }`
  ],
  [
    'iteration-local result',
    'for (const group of groups) { const frame = Buffer.concat([group.header, group.body]); send(frame) }'
  ],
  [
    'iteration-local accumulator',
    'for (const chunk of chunks) { let framed = HEADER; framed = Buffer.concat([framed, chunk]); send(framed) }'
  ],
  [
    'no enclosing loop',
    'class S { handle(chunk) { const buffer = Buffer.concat([this.pending, chunk]); this.pending = parse(buffer).pending } }'
  ],
  ['no Buffer concat', 'export const x = 1']
]

describe('quadratic Buffer.concat Oxlint plugin', () => {
  it.each(violations)('reports %s', (_name, source, accumulator) => {
    const diagnostics = lintSource(source)

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].message).toContain(accumulator)
  })

  it.each(accepted)('accepts %s', (_name, source) => {
    expect(lintSource(source)).toEqual([])
  })
})
