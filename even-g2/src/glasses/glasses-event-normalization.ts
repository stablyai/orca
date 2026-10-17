// Unit 2 — normalizes every verified platform quirk (spec S7) into HudInput, in one tested
// place. Bridge impls (even-hub-bridge.ts, MockGlassesBridge) emit raw GlassesRawEvent as-is;
// normalization/dedupe/throttling happens only here.
import type { GlassesRawEvent } from './glasses-bridge'
import type { HudInput } from '../navigation/nav-contract'

// OsEventTypeList values (Appendix A) — kept as plain numbers so this module never imports
// the SDK (that's confined to even-hub-bridge.ts).
const CLICK = 0
const SCROLL_TOP = 1
const SCROLL_BOTTOM = 2
const DOUBLE_CLICK = 3
const FOREGROUND_ENTER = 4
const FOREGROUND_EXIT = 5
const ABNORMAL_EXIT = 6
const SYSTEM_EXIT = 7

export type GlassesEventNormalizerOptions = {
  now?: () => number
  scrollCooldownMs?: number
  sysDedupeWindowMs?: number
}

export function createGlassesEventNormalizer(
  opts: GlassesEventNormalizerOptions = {}
): (raw: GlassesRawEvent) => HudInput | null {
  const now = opts.now ?? (() => Date.now())
  const scrollCooldownMs = opts.scrollCooldownMs ?? 300
  const sysDedupeWindowMs = opts.sysDedupeWindowMs ?? 600

  let lastScrollAt = -Infinity
  let lastSysEventKey: number | null = null
  let lastSysEventAt = -Infinity

  return (raw: GlassesRawEvent): HudInput | null => {
    const t = now()
    // Quirk 1: CLICK (0) arrives as `undefined` after SDK JSON normalization.
    const eventType = raw.eventType === undefined ? CLICK : raw.eventType

    // Quirk 4: duplicate sys events (~50-100ms apart on real hardware) within the dedupe
    // window are dropped. Scoped to source === 'sys' — list/text click storms are legitimate
    // user input, not a platform artifact.
    if (raw.source === 'sys') {
      if (lastSysEventKey === eventType && t - lastSysEventAt < sysDedupeWindowMs) {
        return null
      }
      lastSysEventKey = eventType
      lastSysEventAt = t
    }

    if (eventType === CLICK) {
      // Quirk 3: item 0 click may omit listItemIndex (falsy protobuf value dropped);
      // listItemName usually survives. Presence of either metadata field marks this a list
      // click regardless of `source` (quirk 2: the simulator tags every event 'sys' regardless
      // of origin). But a real host/worktree list click can ALSO omit both fields entirely
      // while still reporting the real `source: 'list'` (finding #4) — treat that case as a
      // list click too (index -1, unknown row), since falling through to a generic `click`
      // silently no-ops in the dashboard/worktree-list reducers.
      if (
        raw.listItemIndex !== undefined ||
        raw.listItemName !== undefined ||
        raw.source === 'list'
      ) {
        return { kind: 'listSelect', index: raw.listItemIndex ?? -1, label: raw.listItemName }
      }
      return { kind: 'click' }
    }

    switch (eventType) {
      case SCROLL_TOP:
      case SCROLL_BOTTOM: {
        // Quirk 5: scroll storm cooldown.
        if (t - lastScrollAt < scrollCooldownMs) {
          return null
        }
        lastScrollAt = t
        return { kind: eventType === SCROLL_TOP ? 'scrollPrev' : 'scrollNext' }
      }
      case DOUBLE_CLICK:
        return { kind: 'doubleClick' }
      case FOREGROUND_ENTER:
        return { kind: 'foregroundEnter' }
      case FOREGROUND_EXIT:
        return { kind: 'foregroundExit' }
      case SYSTEM_EXIT:
        return { kind: 'systemExit' }
      case ABNORMAL_EXIT:
        return { kind: 'abnormalExit' }
      default:
        return null
    }
  }
}
