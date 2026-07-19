import type { AccessoryKeyDescriptor } from '../components/keyboard-accessory/accessory-key-descriptor'

export type BrowserPointerModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

const BROWSER_POINTER_MODIFIERS: { id: BrowserPointerModifier; label: string }[] = [
  { id: 'cmd', label: 'Cmd' },
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' }
]

const BROWSER_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape'] as const

function specialKeyLabel(key: string): string {
  return key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key
}

type BuildArgs = {
  selectedModifiers: BrowserPointerModifier[]
  disabled: boolean
  onToggleModifier: (modifier: BrowserPointerModifier) => void
  onKeypress: (key: string) => void
}

// Why: the browser bar has no PTY, so its buttons are just sticky pointer
// modifiers plus momentary special keys — built here as a pure list so the
// mapping is unit-testable (the mobile package has no component-render tests).
export function buildBrowserKeyboardDescriptors({
  selectedModifiers,
  disabled,
  onToggleModifier,
  onKeypress
}: BuildArgs): AccessoryKeyDescriptor[] {
  const modifierDescriptors: AccessoryKeyDescriptor[] = BROWSER_POINTER_MODIFIERS.map(
    (modifier) => ({
      id: `modifier-${modifier.id}`,
      label: modifier.label,
      active: selectedModifiers.includes(modifier.id),
      disabled,
      onPress: () => onToggleModifier(modifier.id),
      accessibilityLabel: `${modifier.label} click modifier`
    })
  )
  const keyDescriptors: AccessoryKeyDescriptor[] = BROWSER_KEYS.map((key) => ({
    id: `key-${key}`,
    label: specialKeyLabel(key),
    disabled,
    onPress: () => onKeypress(key),
    accessibilityLabel: key
  }))
  return [...modifierDescriptors, ...keyDescriptors]
}
