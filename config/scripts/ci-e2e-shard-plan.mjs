import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  balanceFiles,
  compareIds,
  readTimingBaseline,
  writeAssignment
} from './ci-shard-assignment.mjs'

export function discoverE2eFiles(report) {
  if (report.errors?.length) {
    throw new Error('Playwright discovery reported errors')
  }
  const files = new Map()
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      const file = spec.file.replaceAll('\\', '/')
      if (file.startsWith('/') || file.split('/').includes('..') || /[\n\r>›]/.test(file)) {
        throw new Error(`Unsafe test-list path: ${file}`)
      }
      for (const test of spec.tests) {
        const id = `${test.projectName}:${spec.id}`
        const ids = files.get(file) ?? []
        ids.push(id)
        files.set(file, ids)
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child)
    }
  }
  for (const suite of report.suites) {
    visit(suite)
  }
  if (!files.size) {
    throw new Error('Playwright discovered no tests')
  }
  const ids = [...files.values()].flat()
  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate discovered test identity')
  }
  return Object.fromEntries([...files.entries()].sort(([a], [b]) => compareIds(a, b)))
}

export function planE2e(report, count, baseline) {
  const testsByFile = discoverE2eFiles(report)
  const timings = Object.fromEntries(
    Object.entries(baseline.timings).map(([file, duration]) => [
      file.replace(/^tests\/e2e\//, ''),
      duration
    ])
  )
  const assignment = balanceFiles(Object.keys(testsByFile), count, timings)
  return { ...assignment, testsByFile, baselineSha256: baseline.baselineSha256 }
}

export function verifyE2eSelection(assignment, report) {
  const actual = Object.values(discoverE2eFiles(report)).flat().sort(compareIds)
  const expected = assignment.shards[assignment.selectedShard - 1].files
    .flatMap((file) => assignment.testsByFile[file])
    .sort(compareIds)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Native Playwright selection differs from shard assignment')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--verify') {
    verifyE2eSelection(
      JSON.parse(readFileSync(process.argv[3], 'utf8')),
      JSON.parse(readFileSync(process.argv[4], 'utf8'))
    )
  } else {
    const [input, shard, directory] = process.argv.slice(2)
    const match = shard?.match(/^(\d+)\/(\d+)$/)
    if (!input || !directory || !match) {
      throw new Error('Usage: ci-e2e-shard-plan.mjs DISCOVERY INDEX/COUNT OUTPUT_DIRECTORY')
    }
    const index = Number(match[1])
    const count = Number(match[2])
    if (index < 1 || index > count) {
      throw new Error('Invalid shard index')
    }
    const assignment = planE2e(
      JSON.parse(readFileSync(input, 'utf8')),
      count,
      readTimingBaseline('e2e')
    )
    const selected = assignment.shards[index - 1].files
    if (!selected.length) {
      throw new Error('Empty E2E shard')
    }
    writeAssignment(join(directory, 'assignment.json'), { ...assignment, selectedShard: index })
    writeFileSync(join(directory, 'selected.txt'), `${selected.join('\n')}\n`)
  }
}
