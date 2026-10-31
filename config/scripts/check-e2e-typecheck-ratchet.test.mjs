import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { countTestTypeErrors, main } from './check-e2e-typecheck-ratchet.mjs'

const OUTPUT = [
  "tests/e2e/a.spec.ts(22,10): error TS2305: Module './helpers/flow' has no exported member 'convertThenRetire'.",
  "tests/e2e/a.spec.ts(30,1): error TS2339: Property 'x' does not exist on type 'Y'.",
  "tests/e2e/helpers/b.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  "cloud/apps/relay/src/app.ts(18,8): error TS2307: Cannot find module '@orca-cloud/relay-contract'.",
  '  Continuation line of a multi-line diagnostic.'
].join('\n')

describe('countTestTypeErrors', () => {
  it('counts tests/ errors per file and ignores rows from other workspaces', () => {
    expect(countTestTypeErrors(OUTPUT)).toEqual(
      new Map([
        ['tests/e2e/a.spec.ts', 2],
        ['tests/e2e/helpers/b.ts', 1]
      ])
    )
  })

  it('reads CRLF output', () => {
    expect(countTestTypeErrors(OUTPUT.replaceAll('\n', '\r\n')).get('tests/e2e/a.spec.ts')).toBe(2)
  })
})

describe('main', () => {
  let root = ''
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function withBaseline(text) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-typecheck-ratchet-'))
    fs.mkdirSync(path.join(root, 'config'))
    fs.writeFileSync(path.join(root, 'config/e2e-typecheck-baseline.txt'), text)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  }

  it('fails when a file gains an error, as a missing helper import does', () => {
    withBaseline('1 tests/e2e/a.spec.ts\n1 tests/e2e/helpers/b.ts\n')
    expect(main(root, undefined, OUTPUT)).toBe(1)
    expect(console.error).toHaveBeenCalledWith(OUTPUT)
  })

  it('passes at the baseline and fails until a fixed file is pruned', () => {
    withBaseline('2 tests/e2e/a.spec.ts\n1 tests/e2e/helpers/b.ts\n')
    expect(main(root, undefined, OUTPUT)).toBe(0)
    const fixed = OUTPUT.replace(/^tests\/e2e\/helpers\/b\.ts.*$/m, '')
    expect(main(root, undefined, fixed)).toBe(1)
    expect(main(root, '--prune', fixed)).toBe(0)
    expect(main(root, undefined, fixed)).toBe(0)
  })
})
