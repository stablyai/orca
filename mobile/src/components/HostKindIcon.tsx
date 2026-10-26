import { Monitor, Server } from 'lucide-react-native'
import { isRemoteExecutionHostId } from '../../../src/shared/execution-host'
import { colors } from '../theme/mobile-theme'

/** The desktop's own machine is a monitor, any other host a server, as on the desktop's run targets. */
export function HostKindIcon({ hostId, size }: { hostId: string | undefined; size: number }) {
  // An absent id reads as local: an older host's row may omit it (its label pass fills it in).
  const Icon = isRemoteExecutionHostId(hostId) ? Server : Monitor
  return <Icon size={size} color={colors.textMuted} />
}
