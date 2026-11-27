import { useMobileTranslation } from '../../i18n/use-mobile-translation'

/** Why a phone paired with a desktop link sees no chats, and how to fix it. */
export function useDesktopLinkPairingCopy() {
  const t = useMobileTranslation()
  return {
    title: t('components.desktopLinkPairing.title', 'Chats are hidden on this phone'),
    message: t(
      'components.desktopLinkPairing.message',
      'This phone was paired with a link for another Orca app, so its chats are hidden. Pair again with the code in Settings → Mobile on your computer, or run orca pair --mobile on your server.'
    ),
    repair: t('components.desktopLinkPairing.repair', 'Pair again')
  }
}
