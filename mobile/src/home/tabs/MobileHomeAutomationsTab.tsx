import { CalendarClock } from 'lucide-react-native'
import { Fragment, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, ScrollView, Text, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { toAutomationOwnerPrecondition } from '../../../../src/shared/automations/ownership/automation-owner-precondition'
import {
  automationErrorMessage,
  automationHostOutdated,
  automationOutcomeUnknownMessage
} from '../../automations/automation-error'
import { automationUpdateWrite } from '../../automations/automation-operations'
import type { MobileAutomationRow } from '../../automations/automation-reply-schema'
import { useAutomationCatalog } from '../../automations/use-automation-catalog'
import { useAutomationRuns } from '../../automations/use-automation-runs'
import { useAutomationProjectNames } from '../../automations/use-automation-project-names'
import { automationsEmptyMessage, automationsEmptyTitle } from '../../automations/AutomationList'
import { describeLoadError } from '../../components/feedback/load-error-description'
import { useNow } from '../../hooks/use-now'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { HostProfile } from '../../host-catalog/host-profile'
import { useHostDisplay } from '../../host-descriptors/use-host-display'
import { homeListStylesSheet } from '../home-list-styles'
import { MobileHomeSectionHeading } from '../MobileHomeSectionHeading'
import { MobileHomeAutomationRow, MobileHomeAutomationRunRow } from './MobileHomeAutomationRows'
import { MobileHomeHostPill, useHomeTabHost } from './MobileHomeHostPill'
import { MobileHomeTabHeader } from './MobileHomeTabHeader'
import { HostUpdateNotice } from '../../host-update-notice/HostUpdateNotice'

const RECENT_RUN_LIMIT = 5
const UPDATE_OPTIONS = { failWhenDisconnected: true }
type AutomationCatalog = ReturnType<typeof useAutomationCatalog>

/** One desktop's automations and recent runs; managing them happens on the Automations page. */
export function MobileHomeAutomationsTab(props: {
  hosts: readonly HostProfile[]
  connectedHosts: readonly HostProfile[]
  hostStates: Record<string, ConnectionState>
  bottomInset: number
  onOpenAutomations: (hostId: string) => void
  /** Reports the desktop the tab is showing, so the floating + can create on it. */
  onHostChange: (hostId: string | null) => void
}) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  const { host, pick } = useHomeTabHost(props.hosts, props.connectedHosts)
  const hostId = host?.id ?? null
  const { onHostChange } = props
  useEffect(() => {
    onHostChange(hostId)
  }, [hostId, onHostChange])
  return (
    <>
      <MobileHomeTabHeader title={t('home.tabs.automations', 'Automations')} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: props.bottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        {host ? (
          <>
            <MobileHomeHostPill
              hosts={props.hosts}
              host={host}
              state={props.hostStates[host.id]}
              pickerTitle={t('home.automationsTab.showFor', 'Show automations for')}
              onPick={pick}
            />
            <HostAutomations
              key={host.id}
              host={host}
              state={props.hostStates[host.id]}
              onOpen={() => props.onOpenAutomations(host.id)}
            />
          </>
        ) : (
          <AutomationsEmpty
            title={t('home.automationsTab.emptyTitle', 'Schedule agent work')}
            message={t(
              'home.automationsTab.pairComputer',
              'Pair a computer to view and run automations.'
            )}
          />
        )}
      </ScrollView>
    </>
  )
}

function HostAutomations(props: {
  host: HostProfile
  state: ConnectionState | undefined
  onOpen: () => void
}) {
  const list = useThemedStyles(homeListStylesSheet)
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const desktop = useHostDisplay(props.host).title
  const { client } = useHostClient(props.host.id)
  const catalog = useAutomationCatalog(props.host.id, client)
  const history = useAutomationRuns(client, null, catalog.revision, catalog.connected)
  const enabled = useOptimisticEnabled(catalog)
  const reducedMotion = useReducedMotionEnabled() === true
  const now = useNow(60_000)
  const projectName = useAutomationProjectNames(props.host.id, client, true)
  const emptyTitle = t('home.automationsTab.emptyTitle', 'Schedule agent work')

  if (!catalog.loaded) {
    if (catalog.error) {
      // The catalog reports an old desktop's missing automation methods with this sentence.
      const outdated = automationHostOutdated(catalog.error, t)
      return outdated ? (
        <HostUpdateNotice
          hostId={props.host.id}
          hostName={desktop}
          variant="screen"
          feature={t('home.automationsTab.needsNewerOrca', 'Automations need a newer version.')}
        />
      ) : (
        <AutomationsEmpty
          title={emptyTitle}
          message={describeLoadError(catalog.error, t).message}
        />
      )
    }
    if (props.state !== 'connected') {
      return (
        <AutomationsEmpty
          title={emptyTitle}
          message={t(
            'home.automationsTab.connectDesktop',
            'Connect {{desktop}} to view and run automations.',
            { desktop }
          )}
        />
      )
    }
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (catalog.rows.length === 0) {
    return (
      <AutomationsEmpty title={automationsEmptyTitle(t)} message={automationsEmptyMessage(t)} />
    )
  }
  const runs = history.runs.slice(0, RECENT_RUN_LIMIT)
  return (
    <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(180)}>
      <MobileHomeSectionHeading
        title={t('home.automationsTab.scheduled', 'Scheduled')}
        aside={String(catalog.rows.length)}
        first={false}
      />
      <View style={list.group}>
        {catalog.rows.map((row, index) => (
          <Fragment key={row.automation.id}>
            {index > 0 ? <View style={[list.separator, list.fullSeparator]} /> : null}
            <MobileHomeAutomationRow
              row={row}
              project={projectName(row.automation)}
              enabled={enabled.valueOf(row)}
              disabled={!catalog.connected}
              onToggle={(value) => void enabled.toggle(row, value)}
              onOpen={props.onOpen}
            />
          </Fragment>
        ))}
      </View>
      {runs.length > 0 ? (
        <>
          <MobileHomeSectionHeading
            title={t('automations.mobile.recentRuns', 'Recent runs')}
            first={false}
          />
          <View style={list.group}>
            {runs.map((run, index) => (
              <Fragment key={run.id}>
                {index > 0 ? <View style={list.separator} /> : null}
                <MobileHomeAutomationRunRow run={run} now={now} onOpen={props.onOpen} />
              </Fragment>
            ))}
          </View>
        </>
      ) : null}
    </Animated.View>
  )
}

// The switch shows the requested value until the host answers; a refused write falls back to the host's.
function useOptimisticEnabled(catalog: AutomationCatalog) {
  const t = useMobileTranslation()
  const [requested, setRequested] = useState<ReadonlyMap<string, boolean>>(new Map())
  async function toggle(row: MobileAutomationRow, value: boolean) {
    const id = row.automation.id
    setRequested((previous) => new Map(previous).set(id, value))
    const outcome: { attempted: boolean; saved: boolean; failure: unknown } = {
      attempted: false,
      saved: false,
      failure: null
    }
    await catalog.perform(
      async (client) => {
        outcome.attempted = true
        try {
          return automationUpdateWrite.interpret(
            await automationUpdateWrite.request(
              client,
              {
                id,
                updates: { enabled: value },
                expectedOwner: toAutomationOwnerPrecondition(row.item.selector)
              },
              UPDATE_OPTIONS
            )
          )
        } catch (failure) {
          outcome.failure = failure
          throw failure
        }
      },
      ({ automation }) => {
        outcome.saved = true
        catalog.setRows((previous) =>
          previous.map((entry) => (entry.automation.id === id ? { ...entry, automation } : entry))
        )
      }
    )
    setRequested((previous) => {
      const next = new Map(previous)
      next.delete(id)
      return next
    })
    if (outcome.attempted && !outcome.saved) {
      // The alert carries the failure, so the catalog need not keep it.
      catalog.setError(null)
      Alert.alert(
        t('home.automationsTab.toggleFailed', 'Couldn’t update {{name}}', {
          name: row.automation.name
        }),
        outcome.failure === null
          ? automationOutcomeUnknownMessage(t)
          : automationErrorMessage(outcome.failure, t)
      )
    }
  }
  return {
    valueOf: (row: MobileAutomationRow) =>
      requested.get(row.automation.id) ?? row.automation.enabled,
    toggle
  }
}

function AutomationsEmpty(props: { title: string; message: string }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.empty}>
      <CalendarClock size={28} color={colors.textMuted} />
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {props.title}
      </Text>
      <Text style={styles.emptyBody}>{props.message}</Text>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  loading: { alignItems: 'center', paddingVertical: spacing.xl, marginTop: 32 },
  empty: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: 28,
    marginTop: 32
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  },
  emptyBody: { fontSize: 15, lineHeight: 20, color: colors.textSecondary, textAlign: 'center' }
}))
