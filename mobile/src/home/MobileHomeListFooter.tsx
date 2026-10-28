import { Text, View } from 'react-native'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { MobileHomeQuickActions } from '../components/MobileHomeQuickActions'
import { PickerModal } from '../components/PickerModal'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import type { TaskProvider } from '../../../src/shared/task-providers'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../transport/types'
import type { HomeResumeCard } from '../worktree/home-resume-card'
import { MobileHomeAccountUsageCards } from './MobileHomeAccountUsageCards'
import { MobileHomeResumeCard } from './MobileHomeResumeCard'
import { MobileHomeTasksCard } from './MobileHomeTasksCard'

const DEFAULT_TASK_PROVIDERS: TaskProvider[] = ['github']

export function MobileHomeListFooter(props: {
  accountsHosts: { host: HostProfile; snapshot: AccountsSnapshot }[]
  connectedHosts: HostProfile[]
  resumeCard: HomeResumeCard | null
  taskProvidersByHost: Record<string, TaskProvider[]>
  onCreateWorkspace: () => void
  onOpenAccounts: (hostId: string) => void
  onOpenResume: (card: HomeResumeCard) => void
  onOpenTasks: (hostId: string, provider?: TaskProvider) => void
  onPairDesktop: () => void
}) {
  useMobileColorScheme()
  const tasksHostPicker = useConnectedHostPicker(props.connectedHosts)
  const hostProviders = props.connectedHosts.map((host) => ({
    host,
    providers: props.taskProvidersByHost[host.id] ?? DEFAULT_TASK_PROVIDERS
  }))
  const providers = [...new Set(hostProviders.flatMap((entry) => entry.providers))]

  function openTasks(provider?: TaskProvider) {
    // Why: a provider chip offers only desktops that have it, so it never opens a different one.
    const hosts = provider
      ? hostProviders
          .filter((entry) => entry.providers.includes(provider))
          .map((entry) => entry.host)
      : props.connectedHosts
    tasksHostPicker.pickHost((hostId) => props.onOpenTasks(hostId, provider), hosts)
  }

  return (
    <View>
      {props.resumeCard ? (
        <>
          <Text style={styles.sectionHeading}>Resume</Text>
          <MobileHomeResumeCard card={props.resumeCard} onOpen={props.onOpenResume} />
        </>
      ) : null}
      <Text style={styles.sectionHeading}>Tasks</Text>
      <MobileHomeTasksCard
        enabled={props.connectedHosts.length > 0}
        providers={providers}
        onOpen={openTasks}
      />
      <PickerModal title="Open Tasks On" {...tasksHostPicker.pickerProps} />
      <MobileHomeQuickActions
        connectedHosts={props.connectedHosts}
        onPairDesktop={props.onPairDesktop}
        onCreateWorkspace={props.onCreateWorkspace}
      />
      <MobileHomeAccountUsageCards items={props.accountsHosts} onOpen={props.onOpenAccounts} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  sectionHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  }
}))
