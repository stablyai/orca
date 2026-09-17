import { describe, expect, it } from 'vitest'
// Only the three pure functions are under test; the tsc spawn is proven end to end by CI.
import { diffBaseline, parseBaseline, parseFailingFiles } from './check-tests-typecheck-ratchet.mjs'

describe('the failing-file parser', () => {
  it('names each file once however many errors it carries', () => {
    const output = [
      'src/a.test.ts(12,5): error TS2345: Argument of type x.',
      'src/a.test.ts(19,1): error TS2322: Type y.',
      'src/b.test.tsx(3,3): error TS18047: z is possibly null.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['src/a.test.ts', 'src/b.test.tsx'])
  })

  // tsc indents the "Overload 1 of 2, ..." detail under its error; counting those as files would
  // put unparseable entries in the baseline and make the gate unprunable.
  it('ignores the indented detail lines tsc prints under an error', () => {
    const output = [
      'src/a.test.ts(12,5): error TS2769: No overload matches this call.',
      "  Overload 1 of 2, '(callback: () => Promise<void>): Promise<undefined>', gave the following error.",
      '    Type VitestUtils is missing the following properties.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['src/a.test.ts'])
  })

  it('answers nothing for a clean run', () => {
    expect(parseFailingFiles('')).toEqual([])
  })
})

describe('the baseline diff', () => {
  it('drops comments and blanks when reading the baseline', () => {
    expect([...parseBaseline('# header\n\nsrc/a.test.ts\n  src/b.test.ts  \n')]).toEqual([
      'src/a.test.ts',
      'src/b.test.ts'
    ])
  })

  it('reports a newly failing file as added and a newly clean one as stale', () => {
    expect(
      diffBaseline(['src/a.test.ts', 'src/c.test.ts'], ['src/a.test.ts', 'src/b.test.ts'])
    ).toEqual({ added: ['src/c.test.ts'], stale: ['src/b.test.ts'] })
  })

  it('reports neither when the set is unchanged, which is the green path', () => {
    expect(diffBaseline(['src/a.test.ts'], ['src/a.test.ts'])).toEqual({ added: [], stale: [] })
  })
})
