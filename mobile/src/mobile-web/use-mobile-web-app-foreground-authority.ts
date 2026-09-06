import { useEffect, type RefObject } from 'react'
import { AppState } from 'react-native'

type MobileWebAppForegroundAuthority = {
  updateAppForegroundState(foreground: boolean): void
}

export function useMobileWebAppForegroundAuthority(
  foregroundAuthorityRef: RefObject<MobileWebAppForegroundAuthority | null>
): void {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      foregroundAuthorityRef.current?.updateAppForegroundState(nextState === 'active')
    })
    return () => subscription.remove()
  }, [foregroundAuthorityRef])
}
