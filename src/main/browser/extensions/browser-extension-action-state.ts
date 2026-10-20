/**
 * chrome.action state for one extension in one browser profile. Chrome semantics: a value set with
 * a tabId overrides the global value on that tab only, clearing it (null) falls back to the global
 * value, and a tab's overrides are dropped when the tab navigates to a new document.
 */

export type BrowserExtensionColor = [number, number, number, number]

/** A manifest-style icon: one path, a size → path map, or a PNG data URL made from ImageData. */
export type BrowserExtensionActionIcon =
  | { kind: 'path'; paths: Record<string, string> }
  | { kind: 'data'; dataUrl: string }

export type BrowserExtensionActionDetails = {
  title: string
  /** Relative to the extension root; '' means clicking fires action.onClicked instead. */
  popup: string
  badgeText: string
  badgeBackgroundColor: BrowserExtensionColor | null
  badgeTextColor: BrowserExtensionColor | null
  enabled: boolean
  icon: BrowserExtensionActionIcon | null
}

type Overrides = Partial<BrowserExtensionActionDetails>

export class BrowserExtensionActionState {
  private global: Overrides = {}
  private readonly byTab = new Map<number, Overrides>()
  /** declarativeNetRequest action counts shown as badge text (displayActionCountAsBadgeText). */
  private readonly actionCountByTab = new Map<number, number>()

  constructor(private readonly defaults: BrowserExtensionActionDetails) {}

  get(tabId?: number | null): BrowserExtensionActionDetails {
    const tab = tabId == null ? undefined : this.byTab.get(tabId)
    const details = { ...this.defaults, ...this.global, ...tab }
    const count = tabId == null ? 0 : (this.actionCountByTab.get(tabId) ?? 0)
    // Why: a tab's own badge text beats the count; the count beats the global text (Chrome).
    return count > 0 && tab?.badgeText === undefined
      ? { ...details, badgeText: String(count) }
      : details
  }

  /** Returns whether the shown count changed; 0 hides it. */
  setActionCount(tabId: number, count: number): boolean {
    if ((this.actionCountByTab.get(tabId) ?? 0) === count) {
      return false
    }
    if (count > 0) {
      this.actionCountByTab.set(tabId, count)
    } else {
      this.actionCountByTab.delete(tabId)
    }
    return true
  }

  /** null clears: a tab value falls back to the global one, a global value to the manifest's. */
  set<Key extends keyof BrowserExtensionActionDetails>(
    key: Key,
    value: BrowserExtensionActionDetails[Key] | null,
    tabId?: number | null
  ): void {
    const target = tabId == null ? this.global : this.tabOverrides(tabId)
    if (value === null) {
      delete target[key]
    } else {
      Object.assign(target, { [key]: value })
    }
    if (tabId != null && Object.keys(target).length === 0) {
      this.byTab.delete(tabId)
    }
  }

  /** Returns whether any count was shown. */
  clearActionCounts(): boolean {
    const had = this.actionCountByTab.size > 0
    this.actionCountByTab.clear()
    return had
  }

  /** Returns whether the tab had overrides, so callers only repaint when something changed. */
  forgetTab(tabId: number): boolean {
    const hadCount = this.actionCountByTab.delete(tabId)
    return this.byTab.delete(tabId) || hadCount
  }

  private tabOverrides(tabId: number): Overrides {
    let overrides = this.byTab.get(tabId)
    if (!overrides) {
      overrides = {}
      this.byTab.set(tabId, overrides)
    }
    return overrides
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

export function iconFromPathSpec(spec: unknown): BrowserExtensionActionIcon | null {
  if (typeof spec === 'string' && spec.length > 0) {
    return { kind: 'path', paths: { '16': spec } }
  }
  const record = asRecord(spec)
  if (!record) {
    return null
  }
  const paths = Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  return Object.keys(paths).length > 0 ? { kind: 'path', paths } : null
}

/** Defaults come from manifest.action (MV3) or browser_action (MV2). */
export function readManifestActionDefaults(
  manifest: Record<string, unknown> | undefined,
  extensionName: string
): BrowserExtensionActionDetails {
  const action = asRecord(manifest?.action) ?? asRecord(manifest?.browser_action)
  const title = action?.default_title
  const popup = action?.default_popup
  return {
    title: typeof title === 'string' && title.length > 0 ? title : extensionName,
    popup: typeof popup === 'string' ? popup : '',
    badgeText: '',
    badgeBackgroundColor: null,
    badgeTextColor: null,
    enabled: true,
    icon: iconFromPathSpec(action?.default_icon) ?? iconFromPathSpec(manifest?.icons)
  }
}

const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** Accepts a ColorArray or a hex / rgb() / rgba() string, as chrome.action does. */
export function parseBrowserExtensionColor(input: unknown): BrowserExtensionColor | null {
  if (Array.isArray(input)) {
    if (input.length !== 4 || !input.every((part) => typeof part === 'number')) {
      return null
    }
    const [r, g, b, a] = input.map(clampByte)
    return [r, g, b, a]
  }
  if (typeof input !== 'string') {
    return null
  }
  const text = input.trim()
  const hex = HEX_COLOR.exec(text)?.[1]
  if (hex) {
    const full =
      hex.length <= 4
        ? hex
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : hex
    const parts = full.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []
    const [r, g, b, a = 255] = parts
    return [r, g, b, a]
  }
  const rgb = RGB_COLOR.exec(text)
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4])
    return [
      clampByte(Number(rgb[1])),
      clampByte(Number(rgb[2])),
      clampByte(Number(rgb[3])),
      clampByte(alpha * 255)
    ]
  }
  return null
}

export function browserExtensionColorToCss(color: BrowserExtensionColor | null): string | null {
  if (!color) {
    return null
  }
  const [r, g, b, a] = color
  return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`
}
