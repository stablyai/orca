import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useSyncExternalStore } from 'react'
import { Dimensions } from 'react-native'
import { getResponsiveLayoutMetrics } from '../../../layout/responsive-layout-metrics'
import { useShellStorage } from '../../../platform/shell-storage/shell-storage'
import { persistMirrored, subscribeMirroredKey } from '../../../storage/mirrored-storage-keys'
import { typography } from '../../../theme/mobile-theme'
import { serifFontFamily } from '../../../theme/mobile-serif-font'
import { CHAT_PROSE_SCALE } from '../transcript/messages/mobile-native-chat-message-styles'

export const NATIVE_CHAT_TEXT_KEY = 'orca:nativeChatText'
// Builds from the serif-default change honor a saved `font: 'system'` only with this mark, so saves keep it.
const SETTINGS_VERSION = 2
// The font the reader picked, or null while the chat follows the default. Saves write `font` only when one
// was picked, so a size or spacing change never turns today's default into a choice. Older builds saved
// the whole snapshot with every change; any valid font they stored is read as picked.
let pickedFont: NativeChatFont | null = null

export type NativeChatFont = 'system' | 'serif' | 'mono'
export type NativeChatLineSpacing = 'compact' | 'default' | 'relaxed'
export type NativeChatTextSettings = {
  /** Points; 14 is the chat's original type scale. */
  size: number
  font: NativeChatFont
  lineSpacing: NativeChatLineSpacing
}

export const NATIVE_CHAT_TEXT_SIZE_MIN = 11
export const NATIVE_CHAT_TEXT_SIZE_MAX = 24
const BASE_TEXT_SIZE = 14
const DEFAULT_FONT: NativeChatFont = 'system'
const TABLET_TEXT_SIZE = 16

const LINE_SPACING: Record<NativeChatLineSpacing, number> = {
  compact: 0.9,
  default: 1,
  relaxed: 1.15
}

// Screen, not window: an iPad keeps its default in a narrow split.
export function defaultNativeChatTextSettings(): NativeChatTextSettings {
  const screen = Dimensions.get('screen')
  const tablet = getResponsiveLayoutMetrics(screen.width, screen.height).isTabletLayout
  return {
    size: tablet ? TABLET_TEXT_SIZE : BASE_TEXT_SIZE,
    font: DEFAULT_FONT,
    lineSpacing: 'default'
  }
}

export function clampNativeChatTextSize(size: number): number {
  return Number.isFinite(size)
    ? Math.min(NATIVE_CHAT_TEXT_SIZE_MAX, Math.max(NATIVE_CHAT_TEXT_SIZE_MIN, Math.round(size)))
    : defaultNativeChatTextSettings().size
}

type StoredSettings = { settings: NativeChatTextSettings; font: NativeChatFont | null }

function isNativeChatFont(font: unknown): font is NativeChatFont {
  return font === 'system' || font === 'serif' || font === 'mono'
}

// Unknown fields fall back one by one, so a value from a newer build keeps what this one reads.
function parseSettings(raw: string | null): StoredSettings | null {
  if (raw === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const size = 'size' in parsed ? parsed.size : undefined
  const font = 'font' in parsed && isNativeChatFont(parsed.font) ? parsed.font : null
  const lineSpacing = 'lineSpacing' in parsed ? parsed.lineSpacing : undefined
  const fallback = defaultNativeChatTextSettings()
  return {
    settings: {
      size: typeof size === 'number' ? clampNativeChatTextSize(size) : fallback.size,
      font: font ?? fallback.font,
      lineSpacing:
        lineSpacing === 'compact' || lineSpacing === 'default' || lineSpacing === 'relaxed'
          ? lineSpacing
          : fallback.lineSpacing
    },
    font
  }
}

type Snapshot = { settings: NativeChatTextSettings; stored: boolean }

// The phone default until the first storage read, which measures the screen; importing never does.
let snapshot: Snapshot = {
  settings: { size: BASE_TEXT_SIZE, font: DEFAULT_FONT, lineSpacing: 'default' },
  stored: false
}
// A change made while a read is in flight wins over that older read.
let changeCount = 0
let writes: Promise<void> = Promise.resolve()
let watchingScreen = false
const listeners = new Set<() => void>()

function adopt(settings: NativeChatTextSettings | null): void {
  const next = settings ?? defaultNativeChatTextSettings()
  const stored = settings !== null
  const held = snapshot.settings
  if (
    snapshot.stored === stored &&
    held.size === next.size &&
    held.font === next.font &&
    held.lineSpacing === next.lineSpacing
  ) {
    return
  }
  snapshot = { settings: next, stored }
  for (const listener of listeners) {
    listener()
  }
}

// A foldable's default follows the screen it is on, until a size is saved.
function watchScreen(): void {
  if (watchingScreen) {
    return
  }
  watchingScreen = true
  Dimensions.addEventListener('change', () => {
    if (!snapshot.stored) {
      adopt(null)
    }
  })
}

/** Rereads storage; the page calls it when the app republishes storage after a Settings change. */
export function reloadNativeChatTextSettings(): Promise<void> {
  const readAt = changeCount
  // Read after this runtime's queued saves land, so a reread never adopts storage from before them.
  return writes
    .then(() => AsyncStorage.getItem(NATIVE_CHAT_TEXT_KEY))
    .then((raw) => {
      watchScreen()
      if (changeCount === readAt) {
        adoptStored(raw)
      }
    })
    .catch(() => undefined)
}

// A page's pinch lands in the app's mirror, which keeps Settings current; our own writes are already adopted.
subscribeMirroredKey(NATIVE_CHAT_TEXT_KEY, (raw, source) => {
  if (source === 'page') {
    changeCount += 1
    adoptStored(raw)
  }
})

function adoptStored(raw: string | null): void {
  const stored = parseSettings(raw)
  pickedFont = stored?.font ?? null
  adopt(stored?.settings ?? null)
}
// Read on load: a page's chat chunk loads after its storage arrives, so the first frame has the saved size.
// An edit waits for this read, so it never merges into the defaults and overwrites what was saved.
let hydrated = false
const hydration = reloadNativeChatTextSettings().then(() => {
  hydrated = true
})

function serialize(settings: NativeChatTextSettings, font: NativeChatFont | null): string {
  const { size, lineSpacing } = settings
  return JSON.stringify(
    font === null
      ? { size, lineSpacing, v: SETTINGS_VERSION }
      : { size, font, lineSpacing, v: SETTINGS_VERSION }
  )
}

function persist(
  settings: NativeChatTextSettings | null,
  font: NativeChatFont | null
): Promise<void> {
  changeCount += 1
  const change = changeCount
  pickedFont = font
  adopt(settings)
  // Queue writes so a slower earlier save cannot land after a newer one.
  const write = writes.then(() =>
    persistMirrored(NATIVE_CHAT_TEXT_KEY, settings === null ? null : serialize(settings, font))
  )
  // A failed save shows what storage still holds, unless a newer change is on its way.
  writes = write.catch(() => {
    if (changeCount === change) {
      void reloadNativeChatTextSettings()
    }
  })
  return writes
}

export function updateNativeChatTextSettings(
  change: Partial<NativeChatTextSettings>
): Promise<void> {
  const save = () => persist({ ...snapshot.settings, ...change }, change.font ?? pickedFont)
  return hydrated ? save() : hydration.then(save)
}

export function resetNativeChatTextSettings(): Promise<void> {
  return persist(null, null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The settings, and whether any are saved (Reset has nothing to do otherwise). */
export function useNativeChatTextSettingsSnapshot(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export function useNativeChatTextSettings(): NativeChatTextSettings {
  return useNativeChatTextSettingsSnapshot().settings
}

/** For the chat view: an open page rereads the settings each time the app republishes its storage. */
export function useNativeChatTextSettingsFollowingShell(): NativeChatTextSettings {
  const shellStorage = useShellStorage()
  useEffect(() => {
    if (shellStorage !== null) {
      void reloadNativeChatTextSettings()
    }
  }, [shellStorage])
  return useNativeChatTextSettings()
}

export function nativeChatFontScale(size: number): number {
  return size / BASE_TEXT_SIZE
}

export function nativeChatFontFamily(font: NativeChatFont): string | undefined {
  return font === 'serif' ? serifFontFamily : font === 'mono' ? typography.monoFamily : undefined
}

// The serif reads a size smaller than the system face, so replies set in it take 17 pt at the default size.
const SERIF_PROSE_SCALE = 17 / 13

/** Markdown props for message prose: the chat's larger prose scale, the chosen face and spacing.
 *  The face is for agent replies; your own messages keep the system face, as the composer does. */
export function useNativeChatProseText(
  fontScale: number,
  mine = false
): {
  textScale: number
  fontFamily: string | undefined
  lineSpacing: number
} {
  const { font, lineSpacing } = useNativeChatTextSettings()
  const face = mine ? 'system' : font
  return {
    textScale: (face === 'serif' ? SERIF_PROSE_SCALE : CHAT_PROSE_SCALE) * fontScale,
    fontFamily: nativeChatFontFamily(face),
    lineSpacing: LINE_SPACING[lineSpacing]
  }
}
