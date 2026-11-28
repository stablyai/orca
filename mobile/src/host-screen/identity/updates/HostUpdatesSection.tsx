import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import {
  AGENT_CLI_UPDATE_AGENTS,
  AGENT_CLI_UPDATE_MOBILE_RUNTIME_CAPABILITY,
  type AgentCliUpdateAgent
} from '../../../../../src/shared/agent-launch/installation/agent-cli-update'
import {
  agentCliUpdateBusy,
  agentCliUpdateHostRows,
  agentCliUpdateStartable,
  type AgentCliUpdateHostRow
} from '../../../../../src/shared/agent-launch/installation/agent-cli-update-runs'
import { REMOTE_SERVER_UPDATE_MOBILE_CAPABILITY } from '../../../../../src/shared/remote-runtime/host-catalog/remote-server-update'
import { canUpdateOrcaFromPhone } from '../../../host-descriptors/host-orca-update-support'
import { useRpcClientContext } from '../../../transport/connection/client-context'
import { useHostProtocolGates } from '../../../components/host-connection/host-protocol-gates-context'
import { LIST_LEADING_INSET, ListRow } from '../../../components/list/ListGroup'
import { OrcaLogo } from '../../../components/icons/OrcaLogo'
import { MobileBotTextButton } from '../../../bots/MobileBotTextButton'
import { hostManualUpdateSteps } from '../../../host-descriptors/host-manual-update-steps'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../../platform/clipboard/clipboard'
import { SettingsSection } from '../../../settings/settings-screen-frame'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { HostAgentCliUpdateRow } from './HostAgentCliUpdateRow'
import {
  HostAgentCliUpdateFailureSheet,
  type HostAgentCliUpdateFailure
} from './HostAgentCliUpdateFailureSheet'
import { HostOrcaUpdateSheet } from './HostOrcaUpdateSheet'
import { offeredOrcaVersion } from './host-orca-update-snapshot'
import {
  downloadHostOrcaUpdate,
  readHostOrcaUpdate,
  refreshHostOrcaRestartImpact,
  restartHostOrcaUpdate,
  settleHostOrcaUpdate,
  useHostOrcaUpdate
} from './host-orca-update'
import {
  checkHostAgentCliUpdates,
  forgetDoneHostAgentCliUpdates,
  runHostAgentCliUpdate,
  useHostAgentCliUpdates
} from './host-agent-cli-updates'

type ListedCli = { row: AgentCliUpdateHostRow; updatedTo: string | undefined }

/**
 * The computer's Orca version and, when the computer lets a phone update them, its agent CLIs that
 * have a newer release. With nothing to update it is the plain "Orca version" row.
 */
export function HostUpdatesSection(props: {
  hostId: string
  hostName: string
  client: RpcClient | null
  online: boolean
  showToast: (message: string) => void
  /** Arrived from a "needs a newer Orca" notice: open the update, or say how to update. */
  openUpdate?: boolean
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const clipboard = useClipboardWriter()
  // The host route already read status; reusing its gates keeps the last version across a drop.
  const { desktopAppVersion, hostCapabilities, hostUpdateSupport } = useHostProtocolGates()
  const cliUpdates = hostCapabilities.includes(AGENT_CLI_UPDATE_MOBILE_RUNTIME_CAPABILITY)
  const { hostId, client, online } = props
  const state = useHostAgentCliUpdates(hostId)
  const [failureAgent, setFailureAgent] = useState<AgentCliUpdateAgent | null>(null)
  const connections = useRpcClientContext()
  const orcaUpdates = hostCapabilities.includes(REMOTE_SERVER_UPDATE_MOBILE_CAPABILITY)
  const orca = useHostOrcaUpdate(hostId)
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(() => {
    forgetDoneHostAgentCliUpdates(hostId)
  }, [hostId])
  // Only while Edit computer is in front: a screen pushed over it must not re-check on a reconnect.
  useFocusEffect(
    useCallback(() => {
      if (cliUpdates && online && client) {
        void checkHostAgentCliUpdates(hostId, client)
      }
      // Reads the computer's own updater only: a check there would also start one on its screen.
      if (orcaUpdates && online && client) {
        void readHostOrcaUpdate(client, hostId)
      }
    }, [cliUpdates, orcaUpdates, online, client, hostId])
  )
  const updatedTo = orca.entry?.phase === 'updated' ? orca.entry.currentVersion : null
  const { showToast } = props
  useEffect(() => {
    if (updatedTo && !sheetOpen) {
      showToast(t('host.updates.updatedTo', 'Updated to {{version}}', { version: updatedTo }))
      settleHostOrcaUpdate(hostId)
    }
  }, [updatedTo, sheetOpen, hostId, showToast, t])

  const rows = cliUpdates ? agentCliUpdateHostRows(state) : []
  // An update that landed on this visit keeps its place in the list as "Updated to".
  const listed = cliUpdates
    ? AGENT_CLI_UPDATE_AGENTS.flatMap((agent): ListedCli[] => {
        const row = rows.find((entry) => entry.agent === agent)
        if (row) {
          return [{ row, updatedTo: undefined }]
        }
        const updatedTo = state.done[agent]
        return updatedTo === undefined
          ? []
          : [{ row: { agent, update: null, run: null }, updatedTo }]
      })
    : []
  const anyDone = listed.some((entry) => entry.updatedTo !== undefined)
  const startable = rows.filter(agentCliUpdateStartable)
  const running = rows.some(agentCliUpdateBusy)
  const showUpdateAll = startable.length > 1 && !running
  const run = (agent: AgentCliUpdateAgent) => {
    if (client) {
      void runHostAgentCliUpdate(hostId, client, agent)
    }
  }
  const copy = (command: string) => {
    void clipboard.writeText(command).then(
      () => props.showToast(t('host.updates.commandCopied', 'Command copied')),
      () => props.showToast(t('host.updates.commandNotCopied', 'Couldn’t copy the command'))
    )
  }
  const failureRow = rows.find((row) => row.agent === failureAgent)
  const failure: HostAgentCliUpdateFailure | null =
    failureRow?.run?.phase === 'failed'
      ? {
          agent: failureRow.agent,
          output: failureRow.run.output,
          ...(failureRow.run.command ? { command: failureRow.run.command } : {}),
          retryable: failureRow.update?.runnable === true
        }
      : null

  const installed = orca.snapshot?.appVersion ?? desktopAppVersion
  const offered = offeredOrcaVersion(orca.snapshot)
  // A sheet already under way keeps its row, even once the computer stops offering the version.
  const latest = orca.entry && orca.entry.phase !== 'updated' ? orca.entry.targetVersion : offered
  const support = orca.snapshot?.support ?? hostUpdateSupport
  const automatic = canUpdateOrcaFromPhone(hostCapabilities, support)
  const orcaDue = latest !== null && latest !== installed
  // A finished update is settled by the toast that says so, once the sheet is closed.
  const closeSheet = () => setSheetOpen(false)
  const sheet = (
    <HostOrcaUpdateSheet
      visible={sheetOpen}
      hostName={props.hostName}
      update={orca}
      online={online}
      onClose={closeSheet}
      onDownload={() => void downloadHostOrcaUpdate(connections, hostId, props.hostName)}
      onRestart={() => void restartHostOrcaUpdate(connections, hostId)}
    />
  )
  const openSheet = () => {
    setSheetOpen(true)
    // The confirm names what's running now, not when the download finished.
    if (orca.entry?.phase === 'downloaded') {
      void refreshHostOrcaRestartImpact(connections, hostId)
    } else if (!orca.entry && orca.snapshot?.status.state === 'downloaded') {
      // Already downloaded on the computer: straight to who restarts.
      void downloadHostOrcaUpdate(connections, hostId, props.hostName)
    }
  }

  const openedFromNotice = useRef(false)
  useEffect(() => {
    if (props.openUpdate && automatic && orcaDue && !openedFromNotice.current) {
      openedFromNotice.current = true
      openSheet()
    }
  })

  if (!installed && listed.length === 0) {
    return null
  }
  const updateSteps =
    hostManualUpdateSteps(hostUpdateSupport, hostCapabilities, t) ??
    // Arrived to update with nothing the phone can install: a desktop too old to take it from a
    // phone, or one whose updater hasn't found the version yet, updates from its own window.
    (props.openUpdate &&
    (!automatic || (!orcaDue && orca.snapshot?.status.state !== 'not-available'))
      ? t('host.edit.updateStepsDesktop', 'On the computer, open Orca and check for updates.')
      : null)
  if (listed.length === 0 && !orcaDue) {
    const upToDate = orca.snapshot?.status.state === 'not-available'
    return (
      <>
        <SettingsSection
          footer={updateSteps ?? (upToDate ? t('host.updates.upToDate', 'Up to date') : undefined)}
        >
          <ListRow
            key="version"
            title={t('host.edit.orcaVersion', 'Orca version')}
            value={installed ?? undefined}
          />
        </SettingsSection>
        {/* Stays mounted so a finished update closes itself and says so, once the row stops offering it. */}
        {sheet}
      </>
    )
  }
  return (
    <>
      <SettingsSection
        title={t('host.updates.title', 'Updates')}
        separatorInset={LIST_LEADING_INSET}
        trailing={
          rows.filter((row) => row.update?.runnable).length > 1 ? (
            // Hidden while updates run, but kept in place so the header doesn't jump.
            <View
              style={{ opacity: showUpdateAll ? 1 : 0 }}
              pointerEvents={showUpdateAll ? 'auto' : 'none'}
              accessibilityElementsHidden={!showUpdateAll}
              importantForAccessibility={showUpdateAll ? 'auto' : 'no-hide-descendants'}
            >
              <MobileBotTextButton
                accent
                label={t('host.updates.updateAll', 'Update all')}
                disabled={!online}
                onPress={() => startable.forEach((row) => run(row.agent))}
              />
            </View>
          ) : undefined
        }
        footer={
          anyDone
            ? t(
                'host.updates.doneNote',
                'Updated rows leave the list next time you open this screen.'
              )
            : (updateSteps ?? undefined)
        }
      >
        {installed ? (
          <ListRow
            key="orca"
            title={t('host.updates.orca', 'Orca')}
            leading={<OrcaLogo size={13} />}
            subtitle={
              orcaDue
                ? t('host.updates.versions', '{{installed}} → {{latest}}', {
                    installed,
                    latest
                  })
                : installed
            }
            {...(orcaDue && automatic
              ? {
                  value: t('host.updates.update', 'Update'),
                  valueColor: colors.accentBlue,
                  onPress: openSheet
                }
              : {})}
          />
        ) : null}
        {listed.map(({ row, updatedTo }) => (
          <HostAgentCliUpdateRow
            key={row.agent}
            row={row}
            updatedTo={updatedTo}
            online={online}
            onUpdate={() => run(row.agent)}
            onCopy={copy}
            onOpenFailure={() => setFailureAgent(row.agent)}
          />
        ))}
      </SettingsSection>
      {sheet}
      <HostAgentCliUpdateFailureSheet
        failure={failure}
        hostName={props.hostName}
        online={online}
        onClose={() => setFailureAgent(null)}
        onCopy={copy}
        onTryAgain={(agent) => {
          setFailureAgent(null)
          run(agent)
        }}
      />
    </>
  )
}
