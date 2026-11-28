import { useEffect, useState } from 'react'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { loadHostCatalog } from '../host-catalog/host-store'
import { BOT_LINK_UPDATE_NOTICE, botLinkUpdateNeededLine } from './bot-link-copy'

/** The host list's line for a bot link this host was too old to open; named from the catalog, never the URL. */
export function useBotLinkNotice(hostId: string, notice: string): string | undefined {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const [hostName, setHostName] = useState<string | null>(null)
  const wanted = notice === BOT_LINK_UPDATE_NOTICE
  useEffect(() => {
    if (!wanted) {
      return
    }
    let live = true
    void loadHostCatalog()
      .then((catalog) => catalog.find((entry) => entry.id === hostId)?.name ?? null)
      .catch(() => null)
      .then((name) => {
        if (live) {
          setHostName(name)
        }
      })
    return () => {
      live = false
    }
  }, [hostId, wanted])
  return wanted && hostName !== null
    ? botLinkUpdateNeededLine(t, [hostName], intlLocale)
    : undefined
}
