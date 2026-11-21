import { useState } from 'react'
import { Image } from 'react-native'
import { File, FileText, Globe, SquareTerminal } from '../../components/icons/app-icons'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSessionTabRow } from './mobile-session-tab-rows'

/** The tab's agent icon, else the page's favicon, else an icon for what kind of tab it is. */
export function MobileSessionTabMark({
  row,
  size
}: {
  row: Pick<MobileSessionTabRow, 'tab' | 'agentId'>
  size: number
}) {
  useMobileColorScheme()
  if (row.agentId) {
    return <MobileAgentIcon agentId={row.agentId} size={size} />
  }
  if (row.tab.type === 'browser' && row.tab.faviconUrl) {
    // Keyed so a new icon gets a fresh load instead of the last one's failure.
    return <MobileBrowserFavicon key={row.tab.faviconUrl} url={row.tab.faviconUrl} size={size} />
  }
  return <MobileSessionTabKindIcon type={row.tab.type} size={size} />
}

function MobileSessionTabKindIcon({
  type,
  size
}: {
  type: MobileSessionTabRow['tab']['type']
  size: number
}) {
  const Icon =
    type === 'browser'
      ? Globe
      : type === 'markdown'
        ? FileText
        : type === 'file'
          ? File
          : SquareTerminal
  return <Icon size={size} color={colors.textSecondary} strokeWidth={2.1} />
}

// Icons React Native can't decode (SVG, some ICOs) fall back to the globe, as desktop does.
function MobileBrowserFavicon({ url, size }: { url: string; size: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <MobileSessionTabKindIcon type="browser" size={size} />
  }
  return (
    <Image
      source={{ uri: url }}
      style={{ width: size, height: size }}
      resizeMode="contain"
      fadeDuration={0}
      onError={() => setFailed(true)}
    />
  )
}
