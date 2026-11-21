import { useMemo } from 'react'
import { BRIDGE_READ_ALOUD_MAX_CHARS } from '../../mobile-web-shell/bridge/native-capabilities/bridge-read-aloud-verb'
import { useNativeVerbs } from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import type { ReadAloudEngine } from './read-aloud-contract'

// The page has no voice of its own in the shell's WebView, so the shell speaks; older shells hide the button.
export function useReadAloudEngine(): ReadAloudEngine {
  const verbs = useNativeVerbs()
  return useMemo(
    () => ({
      available: verbs.canReadAloud,
      // The verb refuses longer text; past the cap (about an hour of speech) only the start is read.
      speak: (text) => verbs.readAloud(text.slice(0, BRIDGE_READ_ALOUD_MAX_CHARS)).catch(() => {}),
      stop: () => void verbs.stopReadAloud().catch(() => {})
    }),
    [verbs]
  )
}
