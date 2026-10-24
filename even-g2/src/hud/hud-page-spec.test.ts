import { describe, expect, it } from 'vitest'
import { buildHudPage } from './hud-page-spec'
import type { HudContainerSpec } from '../glasses/glasses-bridge'

function eventCaptureCount(containers: HudContainerSpec[]): number {
  return containers.filter((c) => c.isEventCapture === 1).length
}

function byName(containers: HudContainerSpec[], name: string): HudContainerSpec {
  const found = containers.find((c) => c.name === name)
  if (!found) {
    throw new Error(`expected a container named ${name}`)
  }
  return found
}

describe('buildHudPage', () => {
  it('text layout produces 3 text containers with the fixed geometry and one event capture on body', () => {
    const build = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    expect(build.containers).toHaveLength(3)
    expect(build.containers.every((c) => c.kind === 'text')).toBe(true)
    expect(eventCaptureCount(build.containers)).toBe(1)

    expect(byName(build.containers, 'header')).toMatchObject({
      id: 1,
      x: 0,
      y: 0,
      width: 576,
      height: 36
    })
    expect(byName(build.containers, 'body')).toMatchObject({
      id: 2,
      x: 0,
      y: 36,
      width: 576,
      height: 216,
      isEventCapture: 1
    })
    expect(byName(build.containers, 'footer')).toMatchObject({
      id: 3,
      x: 0,
      y: 252,
      width: 576,
      height: 36
    })
  })

  it('list layout produces header text + list + footer text', () => {
    const build = buildHudPage({ layout: 'list', header: 'H', items: ['a', 'b'], footer: 'F' })
    expect(build.containers).toHaveLength(3)
    expect(eventCaptureCount(build.containers)).toBe(1)

    expect(byName(build.containers, 'header').kind).toBe('text')
    expect(byName(build.containers, 'footer').kind).toBe('text')
    expect(byName(build.containers, 'list')).toMatchObject({
      kind: 'list',
      id: 2,
      x: 0,
      y: 36,
      width: 576,
      height: 216,
      isEventCapture: 1,
      items: ['a', 'b']
    })
  })

  it('clamps header/footer to a single line (56 chars incl. ellipsis), body to 1000 chars', () => {
    const build = buildHudPage({
      layout: 'text',
      header: 'h'.repeat(300),
      body: 'b'.repeat(1500),
      footer: 'f'.repeat(300)
    })
    const header = byName(build.containers, 'header')
    const body = byName(build.containers, 'body')
    const footer = byName(build.containers, 'footer')
    if (header.kind !== 'text' || body.kind !== 'text' || footer.kind !== 'text') {
      throw new Error('expected text containers')
    }
    expect(header.content).toHaveLength(56)
    expect(header.content.endsWith('…')).toBe(true)
    expect(body.content).toHaveLength(1000)
    expect(footer.content).toHaveLength(56)
  })

  it('collapses newlines in header/footer so they never spill past their single line', () => {
    const build = buildHudPage({
      layout: 'text',
      header: 'title\nsecond line',
      body: 'x',
      footer: 'a\nb'
    })
    const header = byName(build.containers, 'header')
    const footer = byName(build.containers, 'footer')
    if (header.kind !== 'text' || footer.kind !== 'text') {
      throw new Error('expected text containers')
    }
    expect(header.content).toBe('title second line')
    expect(footer.content).toBe('a b')
  })

  it('truncates list items to 20 items of <=64 chars each', () => {
    const items = Array.from({ length: 30 }, (_, i) => `item-${i}-`.repeat(10))
    const build = buildHudPage({ layout: 'list', header: 'H', items, footer: 'F' })
    const list = byName(build.containers, 'list')
    if (list.kind !== 'list') {
      throw new Error('expected list container')
    }
    expect(list.items).toHaveLength(20)
    expect(list.items.every((item) => item.length <= 64)).toBe(true)
  })
})
