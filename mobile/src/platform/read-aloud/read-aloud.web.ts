import { useMemo } from 'react'
import { useNativeVerbs } from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import type { ReadAloudEngine } from './read-aloud-contract'

// The page has no voice of its own in the shell's WebView, so the shell speaks; older shells hide the button.
export function useReadAloudEngine(): ReadAloudEngine {
  const verbs = useNativeVerbs()
  return useMemo(
    () => ({
      available: verbs.canReadAloud,
      speak: (text) => verbs.readAloud(text).catch(() => {}),
      stop: () => void verbs.stopReadAloud().catch(() => {})
    }),
    [verbs]
  )
}
