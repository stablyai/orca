import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const file = 'src/shared/native-chat-tool-summary.ts'
const baseline = process.argv[2] ?? '20ab9950654'
const beforeSource = execFileSync('git', ['show', `${baseline}:${file}`], {
  encoding: 'utf8',
  windowsHide: true
})
const afterSource = fs.readFileSync(file, 'utf8')
async function load(contents) {
  const { outputFiles } = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
  )
}
const before = await load(beforeSource),
  after = await load(afterSource)
const display = (m, input) => {
  const d = m.createToolInputDisplay(input)
  return { ...d, formatDetail: d.formatDetail() }
}
let seed = 8121
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 4294967296) * max)
}
const pieces = [
  'a',
  'b',
  '…',
  '😀',
  '\ud800',
  '\udc00',
  '\0',
  '\t',
  '\r',
  '\n',
  ' ',
  '\v',
  '\f',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
  '\u0085',
  '\u200b'
]
for (let i = 0; i < 3000; i++) {
  const input = Array.from({ length: random(500) }, () => pieces[random(pieces.length)]).join('')
  assert.equal(after.summarizeToolInput(input), before.summarizeToolInput(input))
  assert.deepEqual(display(after, input), display(before, input))
}
for (const input of [
  `${'a'.repeat(79)}…`,
  'a'.repeat(80) + ' '.repeat(500),
  ' '.repeat(100000),
  `${'\n'.repeat(100000)}x`,
  { command: 'a '.repeat(50000) },
  { file_path: 'a '.repeat(500) },
  { x: 'a '.repeat(500) },
  JSON.stringify({ command: 'a '.repeat(50000) })
]) {
  assert.deepEqual(display(after, input), display(before, input))
}
for (const [shape, input] of [
  ['tiny', 'ls -la'],
  ['100KB', 'a   b\n\t'.repeat(15000)],
  ['1MB', 'a   b\n\t'.repeat(150000)],
  ['all-space', ' '.repeat(1000000)],
  ['leading', `${' '.repeat(1000000)}x`],
  ['trailing', `x${' '.repeat(1000000)}`],
  ['long-word', 'x'.repeat(1000000)]
]) {
  const samples = { before: [], after: [] }
  for (let i = 0; i < 20; i++) {
    before.createToolInputDisplay(input)
    after.createToolInputDisplay(input)
  }
  for (let r = 0; r < 8; r++) {
    for (const [label, m] of r % 2
      ? [
          ['after', after],
          ['before', before]
        ]
      : [
          ['before', before],
          ['after', after]
        ]) {
      global.gc()
      const start = process.cpuUsage()
      for (let i = 0; i < 20; i++) {
        m.createToolInputDisplay(input)
      }
      const cpu = process.cpuUsage(start)
      samples[label].push((cpu.user + cpu.system) / 20000)
    }
  }
  console.log(JSON.stringify({ shape, samples }))
}
