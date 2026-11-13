// SANDBOX-CONTROL-TYPECHECK: the package typecheck fails on this package's own diagnostics (and config errors),
// and only counts those in imported desktop files.
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs script; no type declarations
import { splitDiagnostics } from '../scripts/typecheck.mjs'

describe('scripts/typecheck.mjs', () => {
  it('keeps own diagnostics with their detail lines, counts imported desktop ones', () => {
    const out = [
      "src/a.ts(1,2): error TS2322: Type 'x' is not assignable to type 'y'.",
      "  Type 'x' is missing properties.",
      "../../../src/shared/b.ts(3,4): error TS2532: Object is possibly 'undefined'.",
      "  detail of a foreign error",
      "test/c.test.ts(5,6): error TS7006: Parameter 'p' implicitly has an 'any' type.",
      ''
    ].join('\n')
    const { own, foreign } = splitDiagnostics(out)
    expect(own).toEqual([
      "src/a.ts(1,2): error TS2322: Type 'x' is not assignable to type 'y'.",
      "  Type 'x' is missing properties.",
      "test/c.test.ts(5,6): error TS7006: Parameter 'p' implicitly has an 'any' type."
    ])
    expect(foreign).toBe(1)
  })

  it('the split is by path prefix: own package paths (src, test, image, scripts, types stub, tsconfig) fail; `..` and absolute paths are imported', () => {
    const line = (path: string) => `${path}(1,1): error TS2322: x`
    const own = ['src/a.ts', 'test/b.test.ts', 'image/c.ts', 'scripts/d.mjs', 'types/xterm-theme.d.ts', 'tsconfig.json', 'new-dir/added-later.ts']
    const imported = ['../../../src/shared/e.ts', '../../node_modules/f/index.d.ts', '/abs/node_modules/g.d.ts']
    const { own: kept, foreign } = splitDiagnostics([...own, ...imported].map(line).join('\n'))
    expect(kept).toEqual(own.map(line))
    expect(foreign).toBe(imported.length)
  })

  it('a diagnostic without a file (config error) is its own', () => {
    expect(splitDiagnostics("error TS2688: Cannot find type definition file for 'x'.").own).toHaveLength(1)
  })
})
