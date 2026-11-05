import { useContext, useMemo } from 'react'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'

/** Withholds Quote while a prompt card hides the composer, as desktop does. */
export function MobileNativeChatQuoteWhileComposerShown({
  composerShown,
  children
}: {
  composerShown: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const overlays = useContext(MobileNativeChatRowOverlaysContext)
  const value = useMemo(
    () => (composerShown ? overlays : { ...overlays, quote: undefined }),
    [composerShown, overlays]
  )
  return (
    <MobileNativeChatRowOverlaysContext.Provider value={value}>
      {children}
    </MobileNativeChatRowOverlaysContext.Provider>
  )
}
