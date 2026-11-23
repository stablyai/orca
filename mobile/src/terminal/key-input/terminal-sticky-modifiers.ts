import type { TerminalShortcutModifier } from './terminal-accessory-keys'

export type StickyModifierLatch = 'off' | 'once' | 'locked'

export type StickyModifiers = Readonly<Record<TerminalShortcutModifier, StickyModifierLatch>>

export const NO_STICKY_MODIFIERS: StickyModifiers = { ctrl: 'off', alt: 'off', shift: 'off' }

export const STICKY_MODIFIER_DOUBLE_TAP_MS = 350

// A tap arms the modifier for the next key, a quick second tap locks it, and any other tap releases it.
export function tapStickyModifier(
  modifiers: StickyModifiers,
  modifier: TerminalShortcutModifier,
  doubleTap: boolean
): StickyModifiers {
  const latch: StickyModifierLatch = doubleTap
    ? 'locked'
    : modifiers[modifier] === 'off'
      ? 'once'
      : 'off'
  return { ...modifiers, [modifier]: latch }
}

export function hasStickyModifier(modifiers: StickyModifiers): boolean {
  return modifiers.ctrl !== 'off' || modifiers.alt !== 'off' || modifiers.shift !== 'off'
}

// The next key takes every held modifier; one-shot modifiers then release.
export function consumeStickyModifiers(modifiers: StickyModifiers): StickyModifiers {
  const release = (latch: StickyModifierLatch): StickyModifierLatch =>
    latch === 'once' ? 'off' : latch
  return {
    ctrl: release(modifiers.ctrl),
    alt: release(modifiers.alt),
    shift: release(modifiers.shift)
  }
}

/** The one character typed onto the end of `previous`, or null for any other edit. */
export function appendedCharacter(previous: string, next: string): string | null {
  if (!next.startsWith(previous)) {
    return null
  }
  const added = Array.from(next.slice(previous.length))
  return added.length === 1 ? added[0]! : null
}
