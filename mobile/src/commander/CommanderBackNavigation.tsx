import { useRef, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react-native'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { CommanderDetailBack } from './commander-detail-back'

export function CommanderBackNavigation({
  active,
  fallback,
  hostTitle,
  children
}: {
  active: boolean
  fallback: () => void
  hostTitle?: string
  children: ReactNode
}) {
  const t = useMobileTranslation()
  const detailBack = useRef<(() => void) | null>(null)
  function back() {
    ;(detailBack.current ?? fallback)()
    return true
  }
  useBackClaim(active ? back : null)
  return (
    <CommanderDetailBack.Provider value={detailBack}>
      {hostTitle !== undefined && (
        <NavBar
          title={hostTitle}
          leading={
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel={t('common.back', 'Back')}
              onPress={back}
            />
          }
        />
      )}
      {children}
    </CommanderDetailBack.Provider>
  )
}
