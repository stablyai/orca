import { Cloud, Monitor, Server } from 'lucide-react-native'
import { isRemoteExecutionHostId } from '../../../../src/shared/execution-host'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

/** The desktop's own machine is a monitor, any other host a server, as on the desktop's run targets. */
export function HostKindIcon({
  hostId,
  size,
  cloud = false
}: {
  hostId: string | undefined
  size: number
  /** An Orca Cloud workspace's host: the Cloud glyph, never a server. */
  cloud?: boolean
}) {
  useMobileColorScheme()
  // An absent id reads as local: an older host's row may omit it (its label pass fills it in).
  const Icon = cloud ? Cloud : isRemoteExecutionHostId(hostId) ? Server : Monitor
  return <Icon size={size} color={colors.textMuted} />
}
