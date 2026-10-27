/** Headless xterm lacks a theme service; answer from renderer attributes with per-PTY OSC color overrides. */
import type { Terminal } from '@xterm/headless'
import {
  formatXColorRgbSpec,
  parseXColorSpec,
  TERMINAL_VIEW_ANSI_COLOR_COUNT,
  type TerminalViewAttributes,
  type TerminalViewRgb
} from '../../shared/terminal-view-attributes'
import { installProgramStatusQueryResponder } from '../../shared/program-status/query-responder'

type ViewAttributeParser = Pick<Terminal['parser'], 'registerOscHandler' | 'registerCsiHandler'>

export type TerminalViewAttributeResponderDeps = {
  parser: ViewAttributeParser
  /** No renderer attributes means silence for color/scheme queries; fabricated defaults can report the wrong theme. */
  getBaseAttributes: () => TerminalViewAttributes | null
  /** Must already be replay/forwarding-window gated by the caller. */
  emitReply: (reply: string) => void
}

export type TerminalViewAttributeResponder = {
  /** Clear OSC overrides on changed renderer attributes, matching visible xterm theme replacement. */
  clearColorOverrides: () => void
}

type SpecialColorSlot = 'foreground' | 'background' | 'cursor'

// Extra OSC 10/11/12 parameters address consecutive slots: OSC 10;?;? queries foreground then background.
const SPECIAL_COLOR_SLOTS: SpecialColorSlot[] = ['foreground', 'background', 'cursor']
const SPECIAL_COLOR_IDENTS: Record<SpecialColorSlot, string> = {
  foreground: '10',
  background: '11',
  cursor: '12'
}

function isValidColorIndex(value: number): boolean {
  return value >= 0 && value < TERMINAL_VIEW_ANSI_COLOR_COUNT
}

// Match xterm’s relativeLuminance2 calculation for private DSR ?996n replies.
function relativeLuminance([r, g, b]: TerminalViewRgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722
}

export function installTerminalViewAttributeResponder(
  deps: TerminalViewAttributeResponderDeps
): TerminalViewAttributeResponder {
  // Preserve per-PTY OSC colors across visibility changes even though snapshot replay loses visible palette mutations.
  const ansiOverrides = new Map<number, TerminalViewRgb>()
  const specialOverrides = new Map<SpecialColorSlot, TerminalViewRgb>()

  const reportColor = (ident: string, rgb: TerminalViewRgb): void => {
    // Match renderer xterm replies byte-for-byte: ST termination and 16-bit channels.
    deps.emitReply(`\x1b]${ident};${formatXColorRgbSpec(rgb)}\x1b\\`)
  }

  const handleSpecialColor = (data: string, offset: number): boolean => {
    const slots = data.split(';')
    for (let i = 0; i < slots.length; ++i, ++offset) {
      if (offset >= SPECIAL_COLOR_SLOTS.length) {
        break
      }
      const slot = SPECIAL_COLOR_SLOTS[offset]
      if (slots[i] === '?') {
        const base = deps.getBaseAttributes()
        if (base) {
          reportColor(SPECIAL_COLOR_IDENTS[slot], specialOverrides.get(slot) ?? base[slot])
        }
      } else {
        const rgb = parseXColorSpec(slots[i])
        if (rgb) {
          specialOverrides.set(slot, rgb)
        }
      }
    }
    // Consume the query because the headless core emits color events without a reply handler.
    return true
  }

  deps.parser.registerOscHandler(4, (data) => {
    const slots = data.split(';')
    while (slots.length > 1) {
      const idx = slots.shift() as string
      const spec = slots.shift() as string
      if (!/^\d+$/.test(idx)) {
        continue
      }
      const index = Number.parseInt(idx, 10)
      if (!isValidColorIndex(index)) {
        continue
      }
      if (spec === '?') {
        const base = deps.getBaseAttributes()
        if (base) {
          reportColor(`4;${index}`, ansiOverrides.get(index) ?? base.ansi[index])
        }
      } else {
        const rgb = parseXColorSpec(spec)
        if (rgb) {
          ansiOverrides.set(index, rgb)
        }
      }
    }
    return true
  })
  installProgramStatusQueryResponder({ parser: deps.parser, emitReply: deps.emitReply })
  deps.parser.registerOscHandler(10, (data) => handleSpecialColor(data, 0))
  deps.parser.registerOscHandler(11, (data) => handleSpecialColor(data, 1))
  deps.parser.registerOscHandler(12, (data) => handleSpecialColor(data, 2))

  // Removing OSC overrides restores the renderer’s pushed theme colors.
  deps.parser.registerOscHandler(104, (data) => {
    if (!data) {
      ansiOverrides.clear()
      return true
    }
    for (const slot of data.split(';')) {
      if (/^\d+$/.test(slot)) {
        ansiOverrides.delete(Number.parseInt(slot, 10))
      }
    }
    return true
  })
  deps.parser.registerOscHandler(110, () => {
    specialOverrides.delete('foreground')
    return true
  })
  deps.parser.registerOscHandler(111, () => {
    specialOverrides.delete('background')
    return true
  })
  deps.parser.registerOscHandler(112, () => {
    specialOverrides.delete('cursor')
    return true
  })

  deps.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
    if (params[0] !== 996) {
      return false
    }
    const base = deps.getBaseAttributes()
    if (base) {
      // xterm derives ?996n from current OSC-mutated color luminance, not the app’s colorSchemeMode.
      const background = specialOverrides.get('background') ?? base.background
      const foreground = specialOverrides.get('foreground') ?? base.foreground
      const dark = relativeLuminance(background) < relativeLuminance(foreground)
      deps.emitReply(`\x1b[?997;${dark ? 1 : 2}n`)
    }
    return true
  })

  return {
    clearColorOverrides: () => {
      ansiOverrides.clear()
      specialOverrides.clear()
    }
  }
}
