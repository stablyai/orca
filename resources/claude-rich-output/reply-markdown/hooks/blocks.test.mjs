import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from './blocks.ts'
import { classify, splitBlocks } from '../../reply-media/hooks/blocks.ts'

const source = Array.from({ length: 3000 }, (_, line) => `line ${line}: **literal** \`sss\``).join(
  '\n'
)

test('a long closed code fence keeps all its literal lines', () => {
  assert.deepEqual(parse(`\`\`\`text\n${source}\n\`\`\``), [
    { kind: 'code', language: 'text', source, hasGapAbove: false }
  ])
})

test('a long incomplete fence stays raw even with a shorter closing run', () => {
  const text = `\`\`\`\`md\n${source}\n\`\`\``
  assert.deepEqual(parse(`## Title\n${text}`), [
    { kind: 'heading', level: 2, text: 'Title', hasGapAbove: false },
    { kind: 'raw', text, hasGapAbove: false }
  ])
})

for (const fence of ['```', '````', '~~~']) {
  test(`a dollar line does not close inside a ${fence} code example`, () => {
    const source = '$$\nx\n$$'
    assert.deepEqual(parse(`Before\n\n$$\n\n${fence}latex\n${source}\n${fence}\n\n## After`), [
      { kind: 'raw', text: 'Before\n\n$$', hasGapAbove: false },
      { kind: 'code', language: 'latex', source, hasGapAbove: true },
      { kind: 'heading', level: 2, text: 'After', hasGapAbove: true }
    ])
  })
}

for (const prose of ['```npm install``` then run setup.', '````literal````', '```lang`invalid']) {
  test(`backticks in prose do not hide later blocks: ${prose}`, () => {
    const formula = '```math\nx^2\n```'
    const text = `${prose}\n\n${formula}\n\n## After`
    assert.deepEqual(parse(text), [
      { kind: 'raw', text: prose, hasGapAbove: false },
      { kind: 'raw', text: formula, hasGapAbove: true },
      { kind: 'heading', level: 2, text: 'After', hasGapAbove: true }
    ])
    assert.deepEqual(
      splitBlocks(text).flatMap((part) => classify(part, new Set(['math'])) ?? []),
      [{ script: 'math', source: 'x^2' }]
    )
  })
}

test('backticks in tilde-fence info still shield literal media', () => {
  const text = '~~~example`literal\n```math\nx^2\n```\n~~~'
  assert.deepEqual(parse(text), [
    { kind: 'code', language: 'example`literal', source: '```math\nx^2\n```', hasGapAbove: false }
  ])
  assert.deepEqual(
    splitBlocks(text).flatMap((part) => classify(part, new Set(['math'])) ?? []),
    []
  )
})
