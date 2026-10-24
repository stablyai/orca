import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSideRailContent, useSideRailStrip } from '../layout/side-rail'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS } from '../terminal/terminal-key-definitions'
import { createTerminalAccessoryRepeatController } from '../terminal/terminal-accessory-repeat'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  BRIDGE_TERMINAL_KEY_IDS,
  BRIDGE_TERMINAL_KEY_RAIL_GRANT,
  type BridgeTerminalKeyId,
  type BridgeTerminalKeyRail
} from './bridge/bridge-terminal-key'

const KEY_HEIGHT = 40

const PASTE_KEY = {
  label: 'Paste',
  accessibilityLabel: 'Paste from clipboard',
  repeatable: false
}

const RAIL_KEYS = BRIDGE_TERMINAL_KEY_IDS.flatMap((id) => {
  const key =
    id === 'paste'
      ? PASTE_KEY
      : TERMINAL_ACCESSORY_KEY_DEFINITIONS.find((definition) => definition.id === id)
  return key ? [{ ...key, id }] : []
})

/** The rail keys a strip this tall fits, in the rail's order. */
function terminalKeyRailKeys(height: number): BridgeTerminalKeyRail {
  // n keys take n heights and n - 1 gaps, inside the rail's vertical padding.
  const fit = Math.floor((height - spacing.xs) / (KEY_HEIGHT + spacing.xs))
  return RAIL_KEYS.slice(0, Math.max(0, fit)).map((key) => key.id)
}

/**
 * The page's terminal keys stood on end in a side inset strip, for a window that has one: the
 * iPhone Duo's status column leaves the rest of its strip empty. Each press goes to the page, which
 * sends it as its own accessory key would; arrows and deletes repeat while held, as there.
 */
export function TerminalKeyRail({
  keys,
  onKey
}: {
  keys: BridgeTerminalKeyRail
  onKey: (key: BridgeTerminalKeyId) => boolean
}) {
  const [repeat] = useState(() => createTerminalAccessoryRepeatController<BridgeTerminalKeyId>())
  useEffect(() => repeat.cancel, [repeat])
  const send = (key: BridgeTerminalKeyId) => Promise.resolve(onKey(key))
  return (
    <View style={styles.rail}>
      {RAIL_KEYS.filter((key) => keys.includes(key.id)).map((key) => (
        <Pressable
          key={key.id}
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          onPressIn={() => {
            if (key.repeatable) {
              repeat.start(key.id, send)
            }
          }}
          onPressOut={() => {
            if (key.repeatable) {
              repeat.stop()
            }
          }}
          onPress={() => {
            if (!key.repeatable) {
              onKey(key.id)
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
        >
          <Text style={styles.keyText} numberOfLines={1} adjustsFontSizeToFit>
            {key.label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys this shell screen's rail shows: those its side strip fits, when the window has one, the
 * page is open on the focused screen, was granted the rail, which only a session route is, and
 * claims it, which it does only while a terminal and its key row are on screen. Empty otherwise.
 */
export function useShellKeyRail(args: {
  /** The session on screen, or null while none is ready. A claim belongs to the one that made it. */
  sessionId: string | null
  overlay: boolean
  routeGrants: readonly string[]
}): { keys: BridgeTerminalKeyRail; reportClaim: (claimed: boolean) => void } {
  const { sessionId } = args
  const height = useSideRailStrip()?.height ?? null
  const [claimedBy, setClaimedBy] = useState<string | null>(null)
  // Focus rather than mount: the stack keeps this screen mounted under whatever is pushed over it.
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const took =
    sessionId !== null &&
    claimedBy === sessionId &&
    focused &&
    !args.overlay &&
    args.routeGrants.includes(BRIDGE_TERMINAL_KEY_RAIL_GRANT)
  const keys = useMemo(
    () => (took && height !== null ? terminalKeyRailKeys(height) : NO_RAIL_KEYS),
    [took, height]
  )
  const reportClaim = useCallback(
    (claimed: boolean) => setClaimedBy(claimed ? sessionId : null),
    [sessionId]
  )
  return { keys, reportClaim }
}

/** Draws the rail and tells the page which keys it holds, so the page drops just those. */
export function usePublishedShellKeyRail(
  keys: BridgeTerminalKeyRail,
  bridge: {
    publishTerminalKeyRail: (keys: BridgeTerminalKeyRail) => void
    sendTerminalKey: (key: BridgeTerminalKeyId) => boolean
  }
): void {
  const { publishTerminalKeyRail } = bridge
  useEffect(() => {
    publishTerminalKeyRail(keys)
  }, [publishTerminalKeyRail, keys])
  // Held, so a new bridge identity does not rebuild the node, which would show the rail again.
  const sendRef = useRef(bridge.sendTerminalKey)
  sendRef.current = bridge.sendTerminalKey
  const node = useMemo(
    () =>
      keys.length > 0 ? (
        <TerminalKeyRail keys={keys} onKey={(key) => sendRef.current(key)} />
      ) : null,
    [keys]
  )
  useSideRailContent(node)
}

const styles = StyleSheet.create({
  rail: {
    flex: 1,
    alignItems: 'stretch',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  key: {
    height: KEY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  keyPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  }
})
