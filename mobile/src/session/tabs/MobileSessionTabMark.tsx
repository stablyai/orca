import { File, FileText, Globe, SquareTerminal } from 'lucide-react-native'
import { MobileAgentIcon } from '../../components/MobileAgentIcon'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSessionTabRow } from './mobile-session-tab-rows'

/** The tab's agent icon, else an icon for what kind of tab it is. */
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
  const Icon =
    row.tab.type === 'browser'
      ? Globe
      : row.tab.type === 'markdown'
        ? FileText
        : row.tab.type === 'file'
          ? File
          : SquareTerminal
  return <Icon size={size} color={colors.textSecondary} strokeWidth={2.1} />
}
