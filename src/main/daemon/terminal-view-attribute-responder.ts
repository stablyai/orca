/**
 * Phase 5 slice 2 (View-attribute bridge): OSC 4/10/11/12 and DSR ?996n
 * responder handlers for the runtime
 * headless emulator. The headless xterm core has no theme service, so these
 * handlers compute replies from the renderer's pushed attribute snapshot,
 * with per-PTY OSC SET mutations layered on top — mirroring exactly what the
 * renderer's ThemeService reports for a visible pane. Replies route through
 * the caller's emit sink, which the slice-1 forwarding window already gates,
 * so seeded/replayed bytes and delivered chunks never produce a reply.
 */
import type { Terminal } from '@xterm/headless'
import {
  formatXColorRgbSpec,
  parseXColorSpec,
  TERMINAL_VIEW_ANSI_COLOR_COUNT,
  type TerminalViewAttributes,
  type TerminalViewRgb
} from '../../shared/terminal-view-attributes'

type ViewAttributeParser = Pick<Terminal['parser'], 'registerOscHandler' | 'registerCsiHandler'>

export type TerminalViewAttributeResponderDeps = {
  parser: ViewAttributeParser
  /** Last renderer push, or null before the first push. Null means SILENCE
   *  for every view-attribute query — a fabricated default would resurrect
   *  the default-black OSC-11 bug (design invariant 3). */
  getBaseAttributes: () => TerminalViewAttributes | null
  /** Must already be replay/forwarding-window gated by the caller. */
  emitReply: (reply: string) => void
}

export type TerminalViewAttributeResponder = {
  /** A changed renderer attribute push replaces the whole palette, exactly
   *  like xterm's ThemeService `_setTheme` overwrites OSC-SET-mutated colors
   *  on a visible pane's theme apply. Identical re-pushes (fresh renderer
   *  process) are filtered in main's store and never reach this. */
  clearColorOverrides: () => void
}

type SpecialColorSlot = 'foreground' | 'background' | 'cursor'

// OSC 10/11/12 stack extra params onto consecutive slots (xterm's
// _setOrReportSpecialColor): `OSC 10;?;?` reports foreground then background.
const SPECIAL_COLOR_SLOTS: SpecialColorSlot[] = ['foreground', 'background', 'cursor']
const SPECIAL_COLOR_IDENTS: Record<SpecialColorSlot, string> = {
  foreground: '10',
  background: '11',
  cursor: '12'
}

function isValidColorIndex(value: number): boolean {
  return value >= 0 && value < TERMINAL_VIEW_ANSI_COLOR_COUNT
}

// Mirror of xterm's rgb.relativeLuminance2 (common/Color.ts, WCAG formula) —
// the math CoreBrowserTerminal._reportColorScheme answers ?996n with.
function relativeLuminance([r, g, b]: TerminalViewRgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722
}

export function installTerminalViewAttributeResponder(
  deps: TerminalViewAttributeResponderDeps
): TerminalViewAttributeResponder {
  // Why per-instance maps: SET mutations are per PTY (one emulator per PTY);
  // they die with the emulator at teardown, like every other model state.
  // They deliberately survive a reveal→re-hide cycle even though the revealed
  // xterm restores without palette mutations (SerializeAddon emits no OSC
  // color SETs): the TUI never reset its SET, so holding it is
  // protocol-correct — the visible-side loss is the pre-existing restore
  // limitation, not this model's.
  const ansiOverrides = new Map<number, TerminalViewRgb>()
  const specialOverrides = new Map<SpecialColorSlot, TerminalViewRgb>()

  const reportColor = (ident: string, rgb: TerminalViewRgb): void => {
    // Why ST (not BEL) and 16-bit channels: byte-for-byte parity with the
    // renderer xterm's reply (CoreBrowserTerminal._handleColorEvent).
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
    // True consumes the sequence; the headless core's own OSC 10/11/12
    // handler only fires an onColor event nothing consumes.
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
  deps.parser.registerOscHandler(10, (data) => handleSpecialColor(data, 0))
  deps.parser.registerOscHandler(11, (data) => handleSpecialColor(data, 1))
  deps.parser.registerOscHandler(12, (data) => handleSpecialColor(data, 2))

  // OSC 104/110/111/112 restore the themed color — dropping the override
  // falls back to the pushed base, the model twin of ThemeService.restoreColor.
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
      // Fall through to the core for every other private DSR (?6n CPR etc.).
      return false
    }
    const base = deps.getBaseAttributes()
    if (base) {
      // Why luminance and not base.colorSchemeMode: a visible xterm answers
      // ?996n from the relative luminance of the CURRENT (OSC-SET-mutated)
      // background vs foreground (CoreBrowserTerminal._reportColorScheme),
      // so a dark terminal theme in a light app mode still answers dark.
      // colorSchemeMode is the app mode and feeds the 2031/997 path only.
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
