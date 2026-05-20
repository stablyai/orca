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

  it('does not accept nonexistent scrollbar classes as Orca scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="max-h-64 overflow-auto scrollbar-none" /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts static cn composition when a sibling argument adds the scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn('max-h-64 overflow-y-auto', 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('reports unstyled cn composition once at the className attribute', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn('max-h-64 overflow-y-auto', 'p-1')} /> }"
    )

    expect(reports).toHaveLength(1)
    expect(reports[0].text).toContain('overflow-y-auto')
  })

  it('does not let conditional scrollbar classes satisfy unconditional vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn('overflow-y-auto', enabled && 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let disabled object keys satisfy vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn('overflow-y-auto', { 'scrollbar-sleek': false })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports computed object keys that add unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn({ ['overflow-y-auto']: true })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts computed object keys that add styled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn({ ['overflow-y-auto']: true, ['scrollbar-sleek']: true })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('reports vertical overflow inside spread object class maps', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn({ ...{ 'overflow-y-auto': true } })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let overwritten object-map scrollbar keys satisfy vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn({ 'overflow-y-auto': true, 'scrollbar-sleek': true, ...{ 'scrollbar-sleek': false } })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('keeps overwritten object-map class keys on conditional spread omission branches', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div className={cn({ 'overflow-y-auto': true, ...(ok ? { 'overflow-y-auto': false } : {}), 'scrollbar-sleek': ok })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts conditional object-map overwrites when remaining overflow branches are styled', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div className={cn({ 'overflow-y-auto': true, ...(ok ? { 'overflow-y-auto': false } : {}), 'scrollbar-sleek': !ok })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('does not let overwritten literal computed scrollbar keys satisfy vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn({ ['overflow-y-auto']: true, ['scrollbar-sleek']: true, 'scrollbar-sleek': false })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not treat className object-map keys as helper config', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn({ 'overflow-y-auto': true, className: 'scrollbar-sleek' })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside Object.assign class maps', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn(Object.assign({ 'overflow-y-auto': true }))} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let overwritten Object.assign scrollbar keys satisfy vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn(Object.assign({ 'overflow-y-auto': true, 'scrollbar-sleek': true }, { 'scrollbar-sleek': false }))} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports conditional computed object keys that can add unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={cn({ [enabled ? 'overflow-y-auto' : '']: true })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts correlated object keys that toggle overflow and scrollbar together', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ open }) { return <div className={cn({ 'overflow-y-auto': open, 'scrollbar-sleek': open })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts correlated boolean expressions that toggle overflow and scrollbar together', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ open }) { return <div className={cn(open && 'overflow-y-auto', open && 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('reports conditional branches that can render vertical overflow without a scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div className={ok ? 'overflow-y-auto' : 'scrollbar-sleek'} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts conditional branches when every vertical overflow branch is styled', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div className={ok ? 'overflow-y-auto scrollbar-sleek' : 'scrollbar-editor'} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('handles large conditional class objects without state expansion', () => {
    const conditionalClasses = Array.from(
      { length: 40 },
      (_, index) => `'px-${index}': flag${index}`
    ).join(', ')
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      `export function Example(props) { return <div className={cn({ 'overflow-y-auto': open, 'scrollbar-sleek': open, ${conditionalClasses} })} /> }`
    )

    expect(reports).toHaveLength(0)
  })

  it('reports vertical overflow inside array method chains', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={['p-2', enabled && 'overflow-y-auto'].filter(Boolean).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside spread class arguments', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn(...['overflow-y-auto'])} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside Array.of chains', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={Array.of('overflow-y-auto').join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside Array.from chains', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={Array.from(['overflow-y-auto']).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let array element selection preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto scrollbar-sleek', 'overflow-y-auto'][1]} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let object property selection preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={{ good: 'overflow-y-auto scrollbar-sleek', bad: 'overflow-y-auto' }.bad} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside unsupported array method receivers', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto'].reverse().join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside unsupported array reductions', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto'].reduce((a, b) => a + ' ' + b)} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow returned by array find', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto'].find(Boolean)} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow returned by array find inside cn', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn(['overflow-y-auto'].find(Boolean))} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let arbitrary find predicates preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto scrollbar-sleek', 'overflow-y-auto'].find((className) => className === 'overflow-y-auto')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside Object.values wrappers', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={Object.values({ bad: 'overflow-y-auto' }).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow preserved through array map chains', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto'].map((className) => className).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let arbitrary map callbacks preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto scrollbar-sleek'].map((className) => className.replace('scrollbar-sleek', '')).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow preserved through array flatMap chains', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto'].flatMap((className) => [className]).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts styled vertical overflow inside array method chains', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={['p-2', enabled && 'overflow-y-auto scrollbar-sleek'].filter(Boolean).join(' ')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('does not let arbitrary filter predicates prove a separate scrollbar class survives', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto', 'scrollbar-sleek'].filter((c) => c !== 'scrollbar-sleek').join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let arbitrary filter predicates preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto scrollbar-sleek', 'overflow-y-auto'].filter((_, index) => index > 0).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let slice prove a separate scrollbar class survives', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['scrollbar-sleek'].slice(1).concat('overflow-y-auto').join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let slice preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto scrollbar-sleek', 'overflow-y-auto'].slice(1).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let arbitrary filter predicates preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={['overflow-y-auto scrollbar-sleek'].filter((c) => c.length > 0).join(' ')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let logical fallback scrollbar classes satisfy the true branch', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={cn(enabled && 'overflow-y-auto' || 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let nullish fallback scrollbar classes satisfy falsy fallback overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ classes }) { return <div className={cn(classes || 'overflow-y-auto', classes ?? 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts falsy fallback scrollbar classes for nullish fallback overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ classes }) { return <div className={cn(classes ?? 'overflow-y-auto', classes || 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('does not let nullish-coalesced object values cover non-nullish falsy states', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ classes }) { return <div className={cn({ 'overflow-y-auto': classes || true, 'scrollbar-sleek': classes ?? true })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not treat arbitrary boolean call arguments as emitted class names', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ classes }) { return <div className={cn('overflow-y-auto', classes.includes('scrollbar-sleek'))} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not inspect arbitrary boolean call receivers as emitted class names', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ mode }) { return <div className={cn(['overflow-y-auto'].includes(mode))} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('reports class-like helper calls that receive unstyled vertical overflow classes', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={makeClasses('overflow-y-auto')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports variant helper className values that contain unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={buttonVariants({ className: 'overflow-y-auto' })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports variant helper computed className values that contain unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={buttonVariants({ ['className']: 'overflow-y-auto' })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside unsupported className wrappers', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={identity('overflow-y-auto')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let unsupported wrappers provide only the scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={cn('overflow-y-auto', identity('scrollbar-sleek'))} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports vertical overflow inside tagged template wrappers', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className={String.raw`overflow-y-auto`} /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let arbitrary tagged templates preserve same-term scrollbar styles', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className={stripScrollbar`overflow-y-auto scrollbar-sleek`} /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('reports unstyled twJoin composition', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={twJoin('overflow-y-auto')} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts styled twJoin composition', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={twJoin('overflow-y-auto', 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts variant helper className values that include a scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div className={buttonVariants({ className: 'overflow-y-auto scrollbar-sleek' })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts styled vertical overflow in a logical fallback branch', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={cn(enabled || 'overflow-y-auto scrollbar-sleek')} /> }"
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

  it('does not let pseudo-state scrollbar variants satisfy unconditional overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="overflow-y-auto hover:scrollbar-sleek" /> }'
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

  it('accepts exhaustive conditional scrollbar style selection', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ editor }) { return <div className={cn('overflow-y-auto', editor ? 'scrollbar-editor' : 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts exhaustive scrollbar style selection with compound conditions', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ open, editor }) { return <div className={cn('overflow-y-auto', open && editor ? 'scrollbar-editor' : 'scrollbar-sleek')} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts exhaustive conditional scrollbar object keys', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ editor }) { return <div className={cn('overflow-y-auto', { 'scrollbar-editor': editor, 'scrollbar-sleek': !editor })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts exhaustive equality predicate scrollbar object keys', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ mode }) { return <div className={cn('overflow-y-auto', { 'scrollbar-editor': mode === 'editor', 'scrollbar-sleek': mode !== 'editor' })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts exhaustive scrollbar object keys with negated compound conditions', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ open, editor }) { return <div className={cn('overflow-y-auto', { 'scrollbar-editor': open && editor, 'scrollbar-sleek': !(open && editor) })} /> }"
    )

    expect(reports).toHaveLength(0)
  })

  it('reports template interpolation branches that can render unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={`${enabled ? 'overflow-y-auto' : ''} p-2`} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts template interpolation branches when every vertical overflow branch is styled', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ enabled }) { return <div className={`p-2 ${enabled ? 'overflow-y-auto scrollbar-sleek' : ''}`} /> }"
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

  it('reports inline vertical overflow without an Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div style={{ overflowY: 'auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports inline shorthand vertical overflow without an Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div style={{ overflow: 'auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports inline two-value shorthand vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div style={{ overflow: 'hidden auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('accepts inline vertical overflow with a sibling Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div style={{ overflow: \'auto\' }} className="scrollbar-sleek" /> }'
    )

    expect(reports).toHaveLength(0)
  })

  it('reports conditional inline vertical overflow without an Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ open }) { return <div style={open ? { overflowY: 'auto' } : {}} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports const inline vertical overflow references without an Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const scrollStyle = { overflowY: 'auto' }; export function Example() { return <div style={scrollStyle} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('resolves duplicate local const style names by lexical scope', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function A() { const style = { overflowY: 'auto' }; return <div style={style} /> } export function B() { const style = {}; return <div /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('resolves duplicate local const spread prop names by lexical scope', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function A() { const props = { style: { overflowY: 'auto' } }; return <div {...props} /> } export function B() { const props = {}; return <div /> }"
    )

    expect(reports.length).toBeGreaterThan(0)
  })

  it('reports JSX spread className props with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div {...{ className: 'overflow-y-auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports logical JSX spread className props with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div {...(ok && { className: 'overflow-y-auto' })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('does not let overwritten JSX className props satisfy vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example() { return <div className="scrollbar-sleek" {...{ className: \'overflow-y-auto\' }} /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('keeps previous JSX className props when a conditional spread omits className', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      'export function Example({ ok }) { return <div className="overflow-y-auto" {...(ok ? { className: \'scrollbar-sleek\' } : {})} /> }'
    )

    expect(reports).toHaveLength(1)
  })

  it('reports JSX spread style props with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div {...{ style: { overflowY: 'auto' } }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports logical inline style spreads with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div style={{ ...(ok && { overflowY: 'auto' }) }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports logical inline style values with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div style={{ overflowY: ok && 'auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('keeps previous JSX style props when a conditional spread omits style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example({ ok }) { return <div style={{ overflowY: 'auto' }} {...(ok ? { style: {} } : {})} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports const JSX spread props with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const props = { className: 'overflow-y-auto' }; export function Example() { return <div {...props} /> }"
    )

    expect(reports.length).toBeGreaterThan(0)
  })

  it('reports const inline vertical overflow shorthand values', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const overflowY = 'auto'; export function Example() { return <div style={{ overflowY }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports property-access inline vertical overflow references', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const styles = { scroll: { overflowY: 'auto' } }; export function Example() { return <div style={styles.scroll} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports nested property-access inline vertical overflow references', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const styles = { nested: { scroll: { overflowY: 'auto' } } }; export function Example() { return <div style={styles.nested.scroll} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports bracket-access inline vertical overflow references', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const styles = { scroll: { overflowY: 'auto' } }; export function Example() { return <div style={styles['scroll']} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports property-access JSX spread props with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const propSets = { scroll: { style: { overflowY: 'auto' } } }; export function Example() { return <div {...propSets.scroll} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports conditional const JSX spread props with unstyled vertical overflow', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "const props = open ? { style: { overflowY: 'auto' } } : {}; export function Example() { return <div {...props} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports computed literal inline vertical overflow properties', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div style={{ ['overflowY']: 'auto' }} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('reports wrapped inline vertical overflow without an Orca scrollbar style', () => {
    const reports = reportUnstyledScrollbars(
      'Example.tsx',
      "export function Example() { return <div style={identity({ overflow: 'auto' })} /> }"
    )

    expect(reports).toHaveLength(1)
  })

  it('normalizes Tailwind variants and important prefixes before matching', () => {
    expect(plainClassName('md:overflow-y-auto')).toBe('overflow-y-auto')
    expect(plainClassName('[&:hover]:overflow-y-auto')).toBe('overflow-y-auto')
    expect(plainClassName('md:!scrollbar-editor')).toBe('scrollbar-editor')
    expect(plainClassName('!scrollbar-editor')).toBe('scrollbar-editor')
  })
})
