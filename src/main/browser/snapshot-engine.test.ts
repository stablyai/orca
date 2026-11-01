import { describe, expect, it, vi } from 'vitest'
import { buildSnapshot, type CdpCommandSender } from './snapshot-engine'

type AXNode = {
  nodeId: string
  backendDOMNodeId?: number
  role?: { type: string; value: string }
  name?: { type: string; value: string }
  properties?: { name: string; value: { type: string; value: unknown } }[]
  childIds?: string[]
  ignored?: boolean
}

function makeSender(nodes: AXNode[]): CdpCommandSender {
  return vi.fn(async (method: string) => {
    if (method === 'Accessibility.enable') {
      return {}
    }
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes }
    }
    throw new Error(`Unexpected CDP method: ${method}`)
  })
}

function node(
  id: string,
  role: string,
  name: string,
  opts?: {
    childIds?: string[]
    backendDOMNodeId?: number
    ignored?: boolean
    properties?: AXNode['properties']
  }
): AXNode {
  return {
    nodeId: id,
    backendDOMNodeId: opts?.backendDOMNodeId ?? Number.parseInt(id, 10),
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    childIds: opts?.childIds,
    ignored: opts?.ignored,
    properties: opts?.properties
  }
}

describe('buildSnapshot', () => {
  it('assigns refs to interactive elements', async () => {
    const nodes: AXNode[] = [
      node('1', 'WebArea', 'page', { childIds: ['2', '3'] }),
      node('2', 'button', 'Submit', { backendDOMNodeId: 10 }),
      node('3', 'link', 'Home', { backendDOMNodeId: 11 })
    ]
    const result = await buildSnapshot(makeSender(nodes))

    expect(result.refs).toHaveLength(2)
    expect(result.refs[0]).toEqual({ ref: '@e1', role: 'button', name: 'Submit' })
    expect(result.refs[1]).toEqual({ ref: '@e2', role: 'link', name: 'Home' })
    expect(result.snapshot).toContain('[@e1] button "Submit"')
    expect(result.snapshot).toContain('[@e2] link "Home"')
  })

  it('skips generic/none/presentation roles', async () => {
    const nodes: AXNode[] = [
      node('1', 'WebArea', 'page', { childIds: ['2'] }),
      node('2', 'generic', '', { childIds: ['3'] }),
      node('3', 'button', 'OK', { backendDOMNodeId: 10 })
    ]
    const result = await buildSnapshot(makeSender(nodes))
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0].name).toBe('OK')
    expect(result.snapshot).not.toContain('generic')
  })

  it('skips ignored nodes but walks their children', async () => {
    const nodes: AXNode[] = [
      node('1', 'WebArea', 'page', { childIds: ['2'] }),
      node('2', 'group', 'ignored group', { childIds: ['3'], ignored: true }),
      node('3', 'button', 'Deep', { backendDOMNodeId: 10 })
    ]
    const result = await buildSnapshot(makeSender(nodes))
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0].name).toBe('Deep')
  })

  it('skips interactive elements without a name', async () => {
    const nodes: AXNode[] = [
      node('1', 'WebArea', 'page', { childIds: ['2', '3'] }),
      node('2', 'button', '', { backendDOMNodeId: 10 }),
      node('3', 'button', 'Labeled', { backendDOMNodeId: 11 })
    ]
    const result = await buildSnapshot(makeSender(nodes))
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0].name).toBe('Labeled')
  })

  it('populates refMap with backendDOMNodeId', async () => {
    const nodes: AXNode[] = [
      node('1', 'WebArea', 'page', { childIds: ['2'] }),
      node('2', 'checkbox', 'Agree', { backendDOMNodeId: 42 })
    ]
    const result = await buildSnapshot(makeSender(nodes))
    const entry = result.refMap.get('@e1')
    expect(entry).toBeDefined()
    expect(entry!.backendDOMNodeId).toBe(42)
    expect(entry!.role).toBe('checkbox')
    expect(entry!.name).toBe('Agree')
  })
})
