import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  useColorScheme: () => 'dark',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => {} }) }
}))
vi.mock('../../../../components/feedback/LoadingSpinner', () => ({
  LoadingSpinner: 'LoadingSpinner'
}))
vi.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_, name) => String(name), has: () => true })
)

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function render(props: Parameters<typeof MobileNativeChatTurnStatus>[0]): ReactTestInstance {
  act(() => {
    tree = create(createElement(MobileNativeChatTurnStatus, props))
  })
  return tree!.root
}

type Style = Record<string, unknown> | false | null | undefined | Style[]
function flat(style: Style | ((state: { pressed: boolean }) => Style)): Record<string, unknown> {
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style
  return Array.isArray(resolved)
    ? Object.assign({}, ...resolved.map(flat))
    : resolved
      ? { ...resolved }
      : {}
}

const text = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => node.props.children)

// The row lines up with the chat's 16 pt column; its line sits 10 pt under a 36 pt row.
const BAR = { minHeight: 36, paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1 }

it('reads "Worked for" once the turn ends, on the chat column above its centred line', () => {
  const root = render({ startedAt: null, workedSeconds: 72, onToggleExpanded: () => {} })

  expect(text(root)).toEqual(['Worked for 1m 12s'])
  const row = root.findByType('Pressable' as never)
  expect(flat(row.props.style)).toMatchObject(BAR)
  expect(root.findAllByType('LoadingSpinner' as never)).toHaveLength(0)
})

it('keeps the line under a running turn whose step shows below it', () => {
  const root = render({ startedAt: Date.now() - 42_000 })

  expect(text(root)).toEqual(['Working for 42s'])
  expect(flat(root.findByType('View' as never).props.style)).toMatchObject(BAR)
  expect(root.findAllByType('LoadingSpinner' as never)).toHaveLength(0)
})

it('spins in place of a bare "Working…" line, with no line under it', () => {
  const root = render({ startedAt: Date.now() - 42_000, live: true })

  expect(text(root)).toEqual(['Working for 42s'])
  const row = flat(root.findAllByType('View' as never)[0]!.props.style)
  expect(row).toMatchObject({ minHeight: 36, paddingHorizontal: 16 })
  expect(row.borderBottomWidth).toBeUndefined()
  expect(root.findAllByType('LoadingSpinner' as never)).toHaveLength(1)
})
