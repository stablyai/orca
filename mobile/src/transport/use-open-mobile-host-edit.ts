import { useCallback, useEffect, useRef } from 'react'
import { useNavigation, useRouter } from 'expo-router'
import {
  navigateToMobileHostEdit,
  type MobileHostEditNavigationController,
  type MobileHostEditRootNavigation
} from './host-edit-navigation'

export function useOpenMobileHostEdit(): (hostId: string) => void {
  const navigation = useNavigation<MobileHostEditRootNavigation>()
  const router = useRouter()
  const pendingRef = useRef<MobileHostEditNavigationController | null>(null)

  useEffect(
    () => () => {
      pendingRef.current?.cancel()
      pendingRef.current = null
    },
    []
  )

  return useCallback(
    (hostId) => {
      pendingRef.current?.cancel()
      pendingRef.current = navigateToMobileHostEdit(navigation, router, hostId)
    },
    [navigation, router]
  )
}
