import { describe, expect, it } from 'vitest'

import { plainClassName, reportUnstyledScrollbars } from './check-styled-scrollbars.mjs'

describe('check-styled-scrollbars', () => {
  it('reports renderer vertical scroll containers without an Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="max-h-64 overflow-y-auto" /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts obvious styled vertical scroll containers', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="max-h-64 overflow-auto scrollbar-sleek" /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('does not accept nonexistent scrollbar classes as Orca scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="max-h-64 overflow-auto scrollbar-none" /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('fails closed when a separate class composer argument supplies the scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn('max-h-64 overflow-y-auto', 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts static class composer arguments when the same literal is styled', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn('max-h-64 overflow-y-auto scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('fails closed when a scrollbar class is only conditionally present', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={cn('overflow-y-auto', enabled && 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts conditional branches when overflow and scrollbar live in the same class literal', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={cn(enabled && 'overflow-y-auto scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('reports vertical scroll inside arbitrary wrappers when the literal is unstyled', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={identity('overflow-y-auto')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not require a vertical scrollbar style for horizontal-only overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <pre className="max-w-full overflow-x-auto" /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('does not let responsive scrollbar variants satisfy unconditional overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="overflow-y-auto md:scrollbar-sleek" /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts matching responsive overflow and scrollbar variants', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="md:overflow-y-auto md:scrollbar-sleek" /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts unconditional scrollbar styles for responsive overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="md:overflow-y-auto scrollbar-sleek" /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('reports inline vertical overflow without an Orca scrollbar class', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div style={{ overflowY: 'auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts inline vertical overflow with a stable Orca scrollbar class', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="scrollbar-editor" style={{ overflow: \'auto\' }} /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('reports logical inline style spreads without an Orca scrollbar class', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ open }) { return <div style={{ ...(open && { overflowY: 'auto' }) }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports JSX spread className props with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div {...{ className: 'overflow-y-auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts JSX spread className props when the same literal is styled', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div {...{ className: 'overflow-y-auto scrollbar-sleek' }} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('supports variant helper className config', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={buttonVariants({ className: 'overflow-y-auto scrollbar-sleek' })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('normalizes Tailwind variants and important prefixes before matching', () => {
    expect(plainClassName('md:overflow-y-auto')).toBe('overflow-y-auto')
    expect(plainClassName('[&:hover]:overflow-y-auto')).toBe('overflow-y-auto')
    expect(plainClassName('md:!scrollbar-editor')).toBe('scrollbar-editor')
    expect(plainClassName('!scrollbar-editor')).toBe('scrollbar-editor')
  })
})
