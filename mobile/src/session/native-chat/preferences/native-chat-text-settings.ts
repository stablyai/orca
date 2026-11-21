import {
  DEFAULT_NATIVE_CHAT_FONT_WEIGHT,
  normalizeNativeChatFontWeight,
  type NativeChatFontWeight
} from '../../../../../src/shared/native-chat/settings/native-chat-font-weight'
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

export type NativeChatFont = 'system' | 'serif' | 'mono'
export type NativeChatLineSpacing = 'compact' | 'default' | 'relaxed'
export type NativeChatTextSettings = {
  /** Points; 14 is the chat's original type scale. */
  size: number
  font: NativeChatFont
  fontWeight: NativeChatFontWeight
  lineSpacing: NativeChatLineSpacing
}

export const NATIVE_CHAT_TEXT_SIZE_MIN = 11
export const NATIVE_CHAT_TEXT_SIZE_MAX = 24
const BASE_TEXT_SIZE = 14
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
    font: 'system',
    fontWeight: DEFAULT_NATIVE_CHAT_FONT_WEIGHT,
    lineSpacing: 'default'
  }
}

export function clampNativeChatTextSize(size: number): number {
  return Number.isFinite(size)
    ? Math.min(NATIVE_CHAT_TEXT_SIZE_MAX, Math.max(NATIVE_CHAT_TEXT_SIZE_MIN, Math.round(size)))
    : defaultNativeChatTextSettings().size
}

// Unknown fields fall back one by one, so a value from a newer build keeps what this one reads.
function parseSettings(raw: string | null): NativeChatTextSettings | null {
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
  const font = 'font' in parsed ? parsed.font : undefined
  const lineSpacing = 'lineSpacing' in parsed ? parsed.lineSpacing : undefined
  const fallback = defaultNativeChatTextSettings()
  return {
    size: typeof size === 'number' ? clampNativeChatTextSize(size) : fallback.size,
    font: font === 'system' || font === 'serif' || font === 'mono' ? font : fallback.font,
    fontWeight: normalizeNativeChatFontWeight(
      'fontWeight' in parsed ? parsed.fontWeight : undefined
    ),
    lineSpacing:
      lineSpacing === 'compact' || lineSpacing === 'default' || lineSpacing === 'relaxed'
        ? lineSpacing
        : fallback.lineSpacing
  }
}

type Snapshot = { settings: NativeChatTextSettings; stored: boolean }

// The phone default until the first storage read, which measures the screen; importing never does.
let snapshot: Snapshot = {
  settings: {
    size: BASE_TEXT_SIZE,
    font: 'system',
    fontWeight: DEFAULT_NATIVE_CHAT_FONT_WEIGHT,
    lineSpacing: 'default'
  },
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
    held.fontWeight === next.fontWeight &&
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
  return Promise.resolve()
    .then(() => AsyncStorage.getItem(NATIVE_CHAT_TEXT_KEY))
    .then((raw) => {
      watchScreen()
      if (changeCount === readAt) {
        adopt(parseSettings(raw))
      }
    })
    .catch(() => undefined)
}

// A page's pinch lands in the app's mirror, which keeps Settings current; our own writes are already adopted.
subscribeMirroredKey(NATIVE_CHAT_TEXT_KEY, (raw, source) => {
  if (source === 'page') {
    changeCount += 1
    adopt(parseSettings(raw))
  }
})
// Read on load: a page's chat chunk loads after its storage arrives, so the first frame has the saved size.
// An edit waits for this read, so it never merges into the defaults and overwrites what was saved.
let hydrated = false
const hydration = reloadNativeChatTextSettings().then(() => {
  hydrated = true
})

function persist(settings: NativeChatTextSettings | null): Promise<void> {
  changeCount += 1
  const change = changeCount
  adopt(settings)
  // Queue writes so a slower earlier save cannot land after a newer one.
  const write = writes.then(() =>
    persistMirrored(NATIVE_CHAT_TEXT_KEY, settings === null ? null : JSON.stringify(settings))
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
  return hydrated
    ? persist({ ...snapshot.settings, ...change })
    : hydration.then(() => persist({ ...snapshot.settings, ...change }))
}

export function resetNativeChatTextSettings(): Promise<void> {
  return persist(null)
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

/** Markdown props for message prose: the chat's larger prose scale, the chosen face and spacing. */
export function useNativeChatProseText(fontScale: number): {
  textScale: number
  fontFamily: string | undefined
  fontWeight: NativeChatFontWeight
  lineSpacing: number
} {
  const { font, fontWeight, lineSpacing } = useNativeChatTextSettings()
  return {
    textScale: CHAT_PROSE_SCALE * fontScale,
    fontFamily: nativeChatFontFamily(font),
    fontWeight,
    lineSpacing: LINE_SPACING[lineSpacing]
  }
}
