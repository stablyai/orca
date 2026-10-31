import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { TEST_RUNNERS, findRunnerDrift } from './check-test-file-runners.mjs'

const owner = '.github/workflows/push-owner-integration.yml'
const source = readFileSync(owner, 'utf8')
const paths = parse(source).on.pull_request.paths
const inputs = [
  'src/main/cli/keyed-promise-queue.ts',
  'src/main/lib/unread-response-body.ts',
  'src/main/persistence/atomic-snapshot-writer.ts',
  'src/main/durable-file-write.ts',
  'src/main/codex-accounts/fs-utils.ts',
  'src/main/win32-utils.ts',
  'mobile/src/terminal/terminal-text-scales.ts'
]
const parent = TEST_RUNNERS.filter((row) => row.name === 'push owner parent')

it('selects the actual owner for each exact dependency without widening to sibling features', () => {
  for (const input of inputs) {
    expect(
      paths.some((pattern) => matchesGlob(input, pattern)),
      input
    ).toBe(true)
    expect(
      paths.some((pattern) => matchesGlob(`${input}x`, pattern)),
      `${input}x`
    ).toBe(false)
  }
  for (const unrelated of [
    'src/main/cli/other.ts',
    'src/main/lib/other.ts',
    'mobile/src/terminal/other.ts',
    'README.md'
  ]) {
    expect(
      paths.some((pattern) => matchesGlob(unrelated, pattern)),
      unrelated
    ).toBe(false)
  }
})

it('requires every dependency literal in its owning workflow even if another source contains it', () => {
  expect(findRunnerDrift(parent, (file) => readFileSync(file, 'utf8'))).toEqual([])
  for (const input of inputs) {
    const problems = findRunnerDrift(parent, (file) =>
      file === owner
        ? source.replace(`- ${input}\n`, '- unrelated.ts\n')
        : `${readFileSync(file, 'utf8')}\n- ${input}\n`
    )
    expect(problems).toEqual([expect.stringContaining(`${owner} does not contain`)])
  }
})
