import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  automationRunEventSourceKey,
  sayAutomationRunEnglish
} from '../../../src/shared/automations/automation-run-row-words'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ScrollView, Text, View, type HostInstance } from 'react-native'
import { Copy, Ellipsis, SquareTerminal } from 'lucide-react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { getAutomationRunContent } from '../../../src/shared/automations/history/automation-run-content'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import { hostStackRouteHref } from '../navigation/host-stack-navigation'
import { useRouteHandoff } from '../navigation/route-handoff'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { TransientToast } from '../components/feedback/TransientToast'
import { useBackClaim } from '../navigation/use-back-claim'
import { useClipboardWriter } from '../platform/clipboard/clipboard'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import type { AutomationHeaderBar } from './AutomationControls'
import {
  automationDate,
  automationRunErrorText,
  automationRunStatusLabel
} from './automation-run-presentation'
import { canOpenAutomationRunAgent } from './automation-run-agent'
import type { MobileAutomationRun } from './automation-reply-schema'
import type { AutomationRunObservation } from './use-automation-runs'
import { useFullAutomationRun } from './use-full-automation-run'
import { automationStyles as styles } from './automation-styles'

export function AutomationRunDetails(props: {
  run: MobileAutomationRun
  client: RpcClient | null
  hostId: string
  executionHost?: ExecutionHostId
  connected: boolean
  history: AutomationRunObservation
  /** The page's offline and failure notes, above the run. */
  notes: ReactNode
  /** The menu's Copied toast, drawn above Open agent's bar. */
  toast: string | null
  onBack: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const history = props.history
  const full = useFullAutomationRun(
    props.client,
    props.connected,
    history.selected ?? props.run,
    history.scope
  )
  const run = full.run
  const runError = automationRunErrorText(run)
  const [opening, setOpening] = useState(false)
  const [barHeight, setBarHeight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const router = useRouteHandoff()
  const mounted = useRef(false)
  const epoch = useRef(0)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  }, [props])
  useEffect(() => {
    mounted.current = true
    const changed = () => {
      epoch.current++
      setOpening(false)
    }
    changed()
    const stop = props.client?.onStateChange(changed)
    return () => {
      mounted.current = false
      epoch.current++
      stop?.()
    }
  }, [props.client, props.hostId, props.executionHost])
  async function openAgent() {
    if (!props.client || opening) {
      return
    }
    setOpening(true)
    setError(null)
    const client = props.client
    const generation = client.getGeneration?.()
    const at = epoch.current
    const current = () =>
      mounted.current &&
      at === epoch.current &&
      client === latest.current.client &&
      props.hostId === latest.current.hostId &&
      props.executionHost === latest.current.executionHost &&
      generation === client.getGeneration?.() &&
      client.getState() === 'connected'
    try {
      const found = await canOpenAutomationRunAgent(client, run)
      if (!current()) {
        return
      }
      if (found === 'unverifiable') {
        setError(
          t(
            'automations.mobile.couldNotVerifyTheOriginalAgentPaneReconnectAndTryAgain',
            'Could not verify the original agent pane. Reconnect and try again.'
          )
        )
        return
      }
      if (found !== 'available' || !run.workspaceId || !run.terminalPaneKey) {
        setError(
          t(
            'automations.mobile.theOriginalAgentPaneIsNoLongerAvailableToOpenSavedOutputRemainsHere',
            'The original agent pane is no longer available to open. Saved output remains here.'
          )
        )
        return
      }
      router.push(
        hostStackRouteHref(
          mobileSessionRouteTarget({
            hostId: props.hostId,
            worktreeId: run.workspaceId,
            paneKey: run.terminalPaneKey,
            name: run.workspaceDisplayName ?? run.title,
            executionHost: props.executionHost
          })
        )
      )
    } catch {
      if (current()) {
        setError(
          t(
            'automations.mobile.couldNotVerifyTheOriginalAgentPaneReconnectAndTryAgain',
            'Could not verify the original agent pane. Reconnect and try again.'
          )
        )
      }
    } finally {
      if (current()) {
        setOpening(false)
      }
    }
  }
  const trigger =
    run.trigger === 'manual'
      ? t('automations.mobile.runNow', 'Run now')
      : run.trigger === 'event'
        ? sayAutomationRunEnglish(automationRunEventSourceKey(run))
        : t('automations.mobile.schedule', 'Schedule')
  const workspace = run.workspaceDisplayName ?? run.runContext?.path ?? run.workspaceId
  const captured = run.outputSnapshot
    ? run.outputSnapshot.truncated
      ? t('automations.mobile.capturedTruncated', 'Captured {{date}} · Output truncated by host', {
          date: automationDate(run.outputSnapshot.capturedAt)
        })
      : t('automations.mobile.capturedDate', 'Captured {{date}}', {
          date: automationDate(run.outputSnapshot.capturedAt)
        })
    : null
  // A run that failed before any output says why once, under its facts.
  const output = getAutomationRunContent(
    { ...run, error: runError },
    t('automations.mobile.noOutput', 'No output content available.')
  )
  // Open agent shows only when the run's pane can open; a gone pane reads as an error on tap.
  const canOpen = props.connected && Boolean(run.terminalPaneKey) && Boolean(run.workspaceId)
  return (
    <>
      <ScrollView style={styles.screen} contentContainerStyle={styles.grouped}>
        {props.notes}
        {history.error ? <SettingsNote error>{history.error}</SettingsNote> : null}
        {history.unavailable ? (
          <SettingsNote>
            {t(
              'automations.mobile.runNoLongerRetained',
              'This run is no longer in the host’s history.'
            )}
          </SettingsNote>
        ) : null}
        <SettingsSection
          first
          footer={runError ? <SettingsNote error>{runError}</SettingsNote> : undefined}
        >
          <ListRow
            title={t('automations.mobile.status', 'Status')}
            value={automationRunStatusLabel(run.status)}
          />
          <ListRow
            title={t('automations.mobile.scheduledFor', 'Scheduled for')}
            value={automationDate(run.scheduledFor)}
          />
          {run.startedAt !== null ? (
            <ListRow
              title={t('automations.mobile.started', 'Started')}
              value={automationDate(run.startedAt)}
            />
          ) : null}
          <ListRow title={t('automations.mobile.trigger', 'Trigger')} value={trigger} />
          {workspace ? (
            <ListRow title={t('automations.mobile.workspace', 'Workspace')} value={workspace} />
          ) : null}
        </SettingsSection>
        {output === runError ? null : (
          <>
            <SectionHeader title={t('automations.mobile.output', 'Output')} />
            <ListGroup>
              <Text selectable style={styles.output}>
                {output}
              </Text>
            </ListGroup>
          </>
        )}
        {full.failed ? (
          <>
            <SettingsNote error>
              {t('automations.mobile.fullOutputUnavailable', "Couldn't load the full output.")}
            </SettingsNote>
            <SettingsSection>
              <ListRow
                title={t('automations.mobile.retryFullOutput', 'Retry')}
                accent
                disabled={!props.connected}
                onPress={full.retry}
              />
            </SettingsSection>
          </>
        ) : captured ? (
          <SettingsNote>{captured}</SettingsNote>
        ) : null}
        {error ? <SettingsNote error>{error}</SettingsNote> : null}
      </ScrollView>
      {canOpen ? (
        <View
          style={styles.bottomBar}
          onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
        >
          <SheetPrimaryButton
            label={t('automations.mobile.openAgent', 'Open agent')}
            icon={SquareTerminal}
            busy={opening}
            onPress={() => void openAgent()}
          />
        </View>
      ) : null}
      <TransientToast message={props.toast} bottomInset={canOpen ? barHeight : 0} />
    </>
  )
}

/** The run's bar: its title over its status, and ⋯ with Copy run ID. */
export function automationRunBar(
  run: MobileAutomationRun,
  onBack: () => void,
  showToast: (message: string) => void
): AutomationHeaderBar {
  return {
    page: { title: run.title, subtitle: automationRunStatusLabel(run.status), onBack },
    trailing: <AutomationRunMenu runId={run.id} showToast={showToast} />
  }
}

function AutomationRunMenu(props: { runId: string; showToast: (message: string) => void }) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HostInstance>(null)
  return (
    <>
      <NavBarButton
        ref={anchor}
        icon={Ellipsis}
        accessibilityLabel={t('automations.mobile.moreActions', 'More actions')}
        onPress={() => setOpen(true)}
      />
      <PullDownMenu
        visible={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        groups={[
          [
            {
              label: t('automations.mobile.copyRunId', 'Copy run ID'),
              icon: Copy,
              onPress: () =>
                void clipboard.writeText(props.runId).then(
                  () => props.showToast(t('common.copied', 'Copied')),
                  () => props.showToast(t('automations.mobile.copyFailed', 'Couldn’t copy'))
                )
            }
          ]
        ]}
      />
    </>
  )
}
