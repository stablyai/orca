import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = path.resolve(import.meta.dirname, '../..')
const SCOPE_SCRIPT = 'config/scripts/pr-code-change-scope.mjs'

// The relative modules a script loads, followed transitively.
function localImports(entry) {
  const seen = new Set()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    const source = readFileSync(path.join(projectDir, file), 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+\.mjs)'/g)) {
      pending.push(path.posix.join(path.posix.dirname(file), match[1]))
    }
  }
  return [...seen]
}

// The detector job sparse-checks-out a fixed list, so a module the scope script imports but the list
// omits fails that job with ERR_MODULE_NOT_FOUND.
describe('the change detector sparse checkout', () => {
  it('includes every module pr-code-change-scope.mjs loads', () => {
    const workflow = parse(readFileSync(path.join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const checkouts = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.with?.['sparse-checkout'])
      .filter((list) => typeof list === 'string' && list.includes(`/${SCOPE_SCRIPT}`))
    expect(checkouts).toHaveLength(1)
    const sparse = new Set(
      checkouts[0]
        .trim()
        .split('\n')
        .map((line) => line.trim())
    )
    const missing = localImports(SCOPE_SCRIPT).filter(
      (file) =>
        !sparse.has(`/${file}`) &&
        ![...sparse].some((entry) => entry.endsWith('/') && `/${file}`.startsWith(entry))
    )
    expect(missing).toEqual([])
  })
})
