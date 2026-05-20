import { describe, expect, it } from 'vitest'
import { plainClassName, reportUnstyledScrollbars } from './check-styled-scrollbars.mjs'

describe('check-styled-scrollbars', () => {
  it('reports renderer vertical scroll containers without an Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="max-h-64 overflow-y-auto p-1" /> }'
    )

    expect(reports).toHaveLength(1)
    expect(reports[0].text).toContain('overflow-y-auto')
  })

  it('accepts styled vertical scroll containers', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="max-h-64 overflow-auto scrollbar-sleek" /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('does not require a vertical scrollbar style for horizontal-only overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <pre className="max-w-full overflow-x-auto" /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('normalizes Tailwind variants and important prefixes before matching', () => {
    expect(plainClassName('md:overflow-y-auto')).toBe('overflow-y-auto')
    expect(plainClassName('!scrollbar-editor')).toBe('scrollbar-editor')
  })
})
