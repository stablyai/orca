import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View'
}))
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  Mask: 'Mask',
  Path: 'Path',
  Rect: 'Rect'
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'LucideIcon',
  House: 'LucideIcon',
  MessageSquare: 'LucideIcon'
}))
vi.mock('../agents/presentation/AgentStateDot', () => ({
  AGENT_ATTENTION_COLOR: '#ef4444',
  AGENT_WORKING_COLOR: '#eab308',
  AgentStateDot: 'AgentStateDot',
  WorkingRing: 'WorkingRing'
}))

import { ChatBadgedIcon } from './MobileBotChatLeading'

type Box = { right: number; width: number }

function readBox(style: unknown): Box | null {
  if (typeof style !== 'object' || style === null || !('right' in style) || !('width' in style)) {
    return null
  }
  const { right, width } = style
  return typeof right === 'number' && typeof width === 'number' ? { right, width } : null
}

function render(live: 'replying' | 'needs-you'): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(createElement(ChatBadgedIcon, { chat: { origin: 'home', live } }))
  })
  return renderer!
}

// The signed-off phone badge: 7 pt on the 15 pt icon's corner, 2 pt past it, with a 1 pt gap cut around it.
function badgeGeometry(renderer: ReactTestRenderer) {
  const badge = renderer.root.find((node) => readBox(node.props.style) !== null)
  const box = readBox(badge.props.style)!
  const circle = renderer.root.find((node) => String(node.type) === 'Circle')
  const unit = 24 / 15
  const centreFromIconEdge = box.right + box.width / 2
  return {
    glyph: String(badge.type),
    size: box.width,
    centre: (15 - centreFromIconEdge) * unit,
    gap: circle.props.r / unit - box.width / 2,
    cutoutCentre: circle.props.cx
  }
}

describe('ChatBadgedIcon', () => {
  it('draws the replying spinner as a 7 pt badge with a 1 pt gap', () => {
    const geometry = badgeGeometry(render('replying'))
    expect(geometry.glyph).toBe('WorkingRing')
    expect(geometry.size).toBe(7)
    expect(geometry.gap).toBeCloseTo(1)
    expect(geometry.cutoutCentre).toBeCloseTo(geometry.centre)
  })

  it('aligns the waiting dot with the icon cutout', () => {
    const geometry = badgeGeometry(render('needs-you'))
    expect(geometry.glyph).toBe('View')
    expect(geometry.size).toBe(7)
    expect(geometry.cutoutCentre).toBeCloseTo(geometry.centre)
  })
})
