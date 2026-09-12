import { readFileSync } from 'node:fs'
import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileTerminalThemeSelection } from '../storage/terminal-theme-preference'
import {
  TERMINAL_THEME_PICKER_ITEMS,
  TerminalThemePickerDrawer,
  TerminalThemeSettings,
  TerminalThemeSwatch,
  type TerminalThemePickerItem,
  type TerminalThemeSlot
} from './TerminalThemeSettings'

const DEFAULTS: MobileTerminalThemeSelection = {
  dark: null,
  light: null,
  useSeparateLightTheme: true
}

const store = vi.hoisted(() => ({
  selection: {
    dark: null,
    light: null,
    useSeparateLightTheme: true
  } as MobileTerminalThemeSelection,
  listeners: new Set<() => void>(),
  save: vi.fn()
}))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))

vi.mock('../storage/terminal-theme-preference', () => ({
  getMobileTerminalThemeSelection: () => store.selection,
  subscribeMobileTerminalThemeSelection: (listener: () => void) => {
    store.listeners.add(listener)
    return () => store.listeners.delete(listener)
  },
  loadMobileTerminalThemeSelection: () => Promise.resolve(store.selection),
  saveMobileTerminalThemeSelection: store.save
}))

const { drawerRender } = vi.hoisted(() => ({ drawerRender: vi.fn() }))
vi.mock('../components/PickerListDrawer', () => ({
  PickerListDrawer: (props: unknown) => {
    drawerRender(props)
    return null
  }
}))

type DrawerProps = {
  visible: boolean
  title: string
  items: TerminalThemePickerItem[]
  selectedId: string
  onSelect: (item: TerminalThemePickerItem) => void
  onClose: () => void
}

function lastDrawerProps(): DrawerProps {
  const call = drawerRender.mock.calls.at(-1)
  if (!call) {
    throw new Error('PickerListDrawer never rendered')
  }
  return call[0] as DrawerProps
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle))
  }
  return (style ?? {}) as Record<string, unknown>
}

function slotRow(renderer: ReactTestRenderer, label: string) {
  const row = renderer.root
    .findAllByType('Pressable')
    .find((node) => String(node.props.accessibilityLabel).startsWith(`${label},`))
  if (!row) {
    throw new Error(`Missing ${label} row`)
  }
  return row
}

// Row text order: the swatch glyph, then the label, then the sublabel.
function rowSublabel(renderer: ReactTestRenderer, label: string): string {
  return String(slotRow(renderer, label).findAllByType('Text')[2]?.props.children)
}

let setSlot: (slot: TerminalThemeSlot | null) => void = () => undefined

function DrawerHarness({ initialSlot }: { initialSlot: TerminalThemeSlot | null }) {
  const [slot, setSlotState] = useState<TerminalThemeSlot | null>(initialSlot)
  setSlot = setSlotState
  return createElement(TerminalThemePickerDrawer, { slot, onClose: () => setSlotState(null) })
}

describe('TerminalThemeSettings', () => {
  let renderer: ReactTestRenderer | null = null
  const openSlot = vi.fn()

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    store.selection = DEFAULTS
    store.listeners.clear()
    openSlot.mockClear()
    drawerRender.mockClear()
    // Mirrors production: the store publishes optimistically before the write.
    store.save.mockReset()
    store.save.mockImplementation(async (patch: Partial<MobileTerminalThemeSelection>) => {
      store.selection = { ...store.selection, ...patch }
      for (const listener of store.listeners) {
        listener()
      }
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function renderSection(): ReactTestRenderer {
    let created: ReactTestRenderer | null = null
    act(() => {
      created = create(createElement(TerminalThemeSettings, { onOpenSlot: openSlot }))
    })
    if (!created) {
      throw new Error('TerminalThemeSettings did not render')
    }
    return created
  }

  it('ships the match-dark-mode switch off, because storage holds the inverse', () => {
    renderer = renderSection()
    expect(store.selection.useSeparateLightTheme).toBe(true)
    expect(renderer.root.findByType('Switch').props.value).toBe(false)
    expect(renderer.root.findByType('Switch').props.accessibilityLabel).toBe('Match dark mode')
  })

  it('shows both slots following the desktop, with the light slot enabled', () => {
    renderer = renderSection()
    expect(rowSublabel(renderer, 'Dark theme')).toBe('Follow desktop')
    expect(rowSublabel(renderer, 'Light theme')).toBe('Follow desktop')
    expect(slotRow(renderer, 'Light theme').props.accessibilityState).toEqual({ disabled: false })
    expect(slotRow(renderer, 'Light theme').props.disabled).toBe(false)
  })

  it('inverts the toggle into storage and makes the light slot inert', () => {
    renderer = renderSection()
    act(() => {
      renderer?.root.findByType('Switch').props.onValueChange(true)
    })
    expect(store.save).toHaveBeenCalledWith({ useSeparateLightTheme: false })
    expect(renderer.root.findByType('Switch').props.value).toBe(true)
    expect(slotRow(renderer, 'Light theme').props.disabled).toBe(true)
    expect(slotRow(renderer, 'Light theme').props.accessibilityState).toEqual({ disabled: true })
    expect(rowSublabel(renderer, 'Light theme')).toBe('Same as dark theme')
  })

  it('opens the slot the row belongs to', () => {
    renderer = renderSection()
    act(() => {
      slotRow(renderer as ReactTestRenderer, 'Dark theme').props.onPress()
    })
    expect(openSlot).toHaveBeenCalledWith('dark')
  })

  it('exposes each row as a button naming its current theme', () => {
    store.selection = { ...DEFAULTS, dark: 'Builtin Tango Light' }
    renderer = renderSection()
    const row = slotRow(renderer, 'Dark theme')
    expect(row.props.accessibilityRole).toBe('button')
    expect(row.props.accessibilityLabel).toBe('Dark theme, Builtin Tango Light')
  })
})

describe('TerminalThemePickerDrawer', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    store.selection = DEFAULTS
    store.listeners.clear()
    drawerRender.mockClear()
    store.save.mockReset()
    store.save.mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function renderDrawer(initialSlot: TerminalThemeSlot | null): ReactTestRenderer {
    let created: ReactTestRenderer | null = null
    act(() => {
      created = create(createElement(DrawerHarness, { initialSlot }))
    })
    if (!created) {
      throw new Error('DrawerHarness did not render')
    }
    return created
  }

  it('lists the sentinel plus every built-in for the opened slot', () => {
    store.selection = { ...DEFAULTS, dark: 'Builtin Tango Light' }
    renderer = renderDrawer('dark')
    const props = lastDrawerProps()
    expect(props.visible).toBe(true)
    expect(props.title).toBe('Dark theme')
    expect(props.selectedId).toBe('Builtin Tango Light')
    expect(props.items).toBe(TERMINAL_THEME_PICKER_ITEMS)
    expect(props.items).toHaveLength(31)
    expect(props.items[0]?.id).toBe('__follow-desktop__')
    expect(props.items[0]?.palette).toBeNull()
    for (const item of props.items.slice(1)) {
      expect(item.label, item.id).toBe(item.id)
      expect(item.palette?.background, item.id).toBeTruthy()
      expect(item.palette?.foreground, item.id).toBeTruthy()
    }
  })

  it('selects the sentinel row when the slot follows the desktop', () => {
    renderer = renderDrawer('light')
    expect(lastDrawerProps().title).toBe('Light theme')
    expect(lastDrawerProps().selectedId).toBe('__follow-desktop__')
  })

  it('stays closed with no slot open', () => {
    renderer = renderDrawer(null)
    expect(lastDrawerProps().visible).toBe(false)
  })

  it('writes null rather than the sentinel id when Follow desktop is chosen', () => {
    store.selection = { ...DEFAULTS, dark: 'Builtin Tango Light' }
    renderer = renderDrawer('dark')
    const props = lastDrawerProps()
    act(() => {
      props.onSelect(props.items[0]!)
    })
    expect(store.save).toHaveBeenCalledWith({ dark: null })
  })

  // PickerListDrawer fires onClose() and then onSelect() one animation later
  // (PickerListDrawer.tsx), so the slot is already null by the time the write runs.
  it.each([
    ['dark', { dark: 'Tokyo Night' }],
    ['light', { light: 'Tokyo Night' }]
  ] as const)('writes the %s slot captured at press time', (slot, expected) => {
    renderer = renderDrawer(slot)
    const props = lastDrawerProps()
    const item = props.items.find((entry) => entry.id === 'Tokyo Night')
    expect(item).toBeTruthy()
    act(() => {
      props.onClose()
    })
    expect(lastDrawerProps().visible).toBe(false)
    act(() => {
      props.onSelect(item!)
    })
    expect(store.save).toHaveBeenCalledWith(expected)
  })

  it('reopens on the other slot after the harness reassigns it', () => {
    renderer = renderDrawer('dark')
    act(() => {
      setSlot('light')
    })
    expect(lastDrawerProps().title).toBe('Light theme')
  })
})

describe('TerminalThemeSwatch', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function renderSwatch(palette: TerminalThemePickerItem['palette']): ReactTestRenderer {
    let created: ReactTestRenderer | null = null
    act(() => {
      created = create(createElement(TerminalThemeSwatch, { palette }))
    })
    if (!created) {
      throw new Error('TerminalThemeSwatch did not render')
    }
    return created
  }

  it('paints the theme it represents and hides itself from screen readers', () => {
    const palette = TERMINAL_THEME_PICKER_ITEMS[1]!.palette!
    renderer = renderSwatch(palette)
    const chip = renderer.root.findAllByType('View')[0]!
    expect(flattenStyle(chip.props.style).backgroundColor).toBe(palette.background)
    expect(chip.props.accessibilityElementsHidden).toBe(true)
    expect(chip.props.importantForAccessibility).toBe('no-hide-descendants')
    const glyph = renderer.root.findByType('Text')
    expect(glyph.props.children).toBe('Aa')
    expect(flattenStyle(glyph.props.style).color).toBe(palette.foreground)
    const dots = renderer.root.findAllByType('View').slice(2)
    expect(dots.map((dot) => flattenStyle(dot.props.style).backgroundColor)).toEqual([
      palette.red,
      palette.green,
      palette.blue
    ])
  })

  it('renders a neutral dotless chip for the follow-desktop row', () => {
    renderer = renderSwatch(null)
    expect(renderer.root.findAllByType('View')).toHaveLength(1)
    expect(renderer.root.findAllByType('View')[0]!.props.accessibilityElementsHidden).toBe(true)
  })
})

describe('terminal settings screen', () => {
  it('renders the theme section and its root-level picker', () => {
    const source = readFileSync(new URL('../../app/terminal-settings.tsx', import.meta.url), 'utf8')
    expect(source).toContain("from '../src/terminal/TerminalThemeSettings'")
    expect(source).toContain('<TerminalThemeSettings onOpenSlot={setThemeSlot} />')
    // The drawer sits outside Animated.ScrollView, which clips a drawer backdrop.
    expect(source.indexOf('<TerminalThemePickerDrawer')).toBeGreaterThan(
      source.indexOf('</Animated.ScrollView>')
    )
  })
})
