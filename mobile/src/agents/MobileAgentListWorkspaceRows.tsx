import { ChevronRight, Folder } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { homeListStyles as styles } from '../home/home-list-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../host-catalog/host-profile'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import type { AgentListWorkspaceMatch } from './agent-list-workspace-matches'

/** Workspaces with no agent that a search found; a tap opens the workspace. */
export function MobileAgentListWorkspaceRows(props: {
  matches: readonly AgentListWorkspaceMatch[]
  hosts: readonly HostProfile[]
  nameDesktop: boolean
  onOpen: (match: AgentListWorkspaceMatch) => void
}) {
  return (
    <View style={styles.group}>
      {props.matches.map((match, index) => (
        <View key={match.key}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <WorkspaceRow
            match={match}
            host={props.hosts.find((host) => host.id === match.hostId) ?? null}
            nameDesktop={props.nameDesktop}
            onOpen={props.onOpen}
          />
        </View>
      ))}
    </View>
  )
}

/** One matched workspace: its name, then "No agent", repo, branch and desktop. */
function WorkspaceRow(props: {
  match: AgentListWorkspaceMatch
  host: HostProfile | null
  nameDesktop: boolean
  onOpen: (match: AgentListWorkspaceMatch) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const desktop = useHostDisplay(props.host).title
  const { workspace } = props.match
  const where = [
    workspace.repo && workspace.repo !== workspace.workspaceName ? workspace.repo : null,
    workspace.branch && workspace.branch !== workspace.workspaceName ? workspace.branch : null,
    props.nameDesktop ? desktop : null
  ]
    .filter(Boolean)
    .join(' · ')
  const status = t('agents.search.noAgent', 'No agent')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[workspace.workspaceName, status, where].filter(Boolean).join(', ')}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => props.onOpen(props.match)}
    >
      <View style={styles.status}>
        <Folder size={14} color={colors.textMuted} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {workspace.workspaceName}
        </Text>
        {/* Two lines so the desktop name at the end stays visible; same-named workspaces differ only by it. */}
        <Text style={styles.subtitle} numberOfLines={2}>
          {where ? `${status} · ${where}` : status}
        </Text>
      </View>
      <View style={styles.trailing}>
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}
