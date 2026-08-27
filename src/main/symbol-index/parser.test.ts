import { describe, expect, it, beforeAll } from 'vitest'
import { initParser, parseDefinitions } from './parser'

beforeAll(async () => {
  await initParser()
})

describe('parseDefinitions', () => {
  it('extracts function and class names from TypeScript', async () => {
    const src = ['export function alpha() {}', '', 'class Beta {', '  gamma() {}', '}'].join('\n')
    const defs = await parseDefinitions('typescript', src, '/w/a.ts')
    const names = defs.map((d) => d.name).sort()
    expect(names).toContain('alpha')
    expect(names).toContain('Beta')
    expect(names).toContain('gamma')
    const alpha = defs.find((d) => d.name === 'alpha')!
    expect(alpha.path).toBe('/w/a.ts')
    expect(alpha.line).toBe(1)
    expect(alpha.column).toBeGreaterThanOrEqual(1)
  })

  it('extracts def and class from Python', async () => {
    const src = ['def foo():', '    pass', '', 'class Bar:', '    pass'].join('\n')
    const defs = await parseDefinitions('python', src, '/w/a.py')
    expect(defs.map((d) => d.name).sort()).toEqual(['Bar', 'foo'])
  })

  it('returns [] for unsupported language and for garbage input', async () => {
    expect(await parseDefinitions('plaintext', 'whatever', '/w/a.txt')).toEqual([])
    expect(await parseDefinitions('typescript', '((((', '/w/a.ts')).toEqual([])
  })
})
