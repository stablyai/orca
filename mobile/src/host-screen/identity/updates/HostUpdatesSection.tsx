import { useCallback, useEffect, useState } from 'react'
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
import { useHostProtocolGates } from '../../../components/host-connection/host-protocol-gates-context'
import { LIST_LEADING_INSET, ListRow } from '../../../components/list/ListGroup'
import { OrcaLogo } from '../../../components/icons/OrcaLogo'
import { MobileBotTextButton } from '../../../bots/MobileBotTextButton'
import { hostManualUpdateSteps } from '../../../host-descriptors/host-manual-update-steps'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../../platform/clipboard/clipboard'
import { SettingsSection } from '../../../settings/settings-screen-frame'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { HostAgentCliUpdateRow } from './HostAgentCliUpdateRow'
import {
  HostAgentCliUpdateFailureSheet,
  type HostAgentCliUpdateFailure
} from './HostAgentCliUpdateFailureSheet'
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
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  // The host route already read status; reusing its gates keeps the last version across a drop.
  const { desktopAppVersion, hostCapabilities, hostUpdateSupport } = useHostProtocolGates()
  const cliUpdates = hostCapabilities.includes(AGENT_CLI_UPDATE_MOBILE_RUNTIME_CAPABILITY)
  const { hostId, client, online } = props
  const state = useHostAgentCliUpdates(hostId)
  const [failureAgent, setFailureAgent] = useState<AgentCliUpdateAgent | null>(null)

  useEffect(() => {
    forgetDoneHostAgentCliUpdates(hostId)
  }, [hostId])
  // Only while Edit computer is in front: a screen pushed over it must not re-check on a reconnect.
  useFocusEffect(
    useCallback(() => {
      if (cliUpdates && online && client) {
        void checkHostAgentCliUpdates(hostId, client)
      }
    }, [cliUpdates, online, client, hostId])
  )

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

  if (!desktopAppVersion && listed.length === 0) {
    return null
  }
  const updateSteps = hostManualUpdateSteps(hostUpdateSupport, hostCapabilities, t)
  if (listed.length === 0) {
    return (
      <SettingsSection footer={updateSteps ?? undefined}>
        <ListRow
          key="version"
          title={t('host.edit.orcaVersion', 'Orca version')}
          value={desktopAppVersion ?? undefined}
        />
      </SettingsSection>
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
        {desktopAppVersion ? (
          <ListRow
            key="orca"
            title={t('host.updates.orca', 'Orca')}
            leading={<OrcaLogo size={13} />}
            subtitle={desktopAppVersion}
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
