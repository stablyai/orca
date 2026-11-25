import { useRef } from 'react'
import { ActionSheetContent, type ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileAgentTileGrid } from '../session/agent-launch/MobileAgentTileGrid'
import type { MobileNewTabAgentOption } from '../session/agent-launch/mobile-new-tab-agent-options'
import { useMobileNewTabAgentOptions } from '../session/agent-launch/use-mobile-new-tab-agent-options'
import { mobileAgentLoadStatusRow } from '../session/agent-launch/mobile-agent-load-status-row'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { AgentSessionContinuationContextMode } from '../../../src/shared/agent-session/conversation-context/agent-session-continuation'

type Props = {
  visible: boolean
  sessionTitle: string
  agentOptions: readonly MobileNewTabAgentOption[]
  /** Loading, none, other-server or error; shown instead of the agent tiles. */
  agentStatusRow: ActionSheetAction | null
  /** Null when only the latest status can be handed over (no saved transcript). */
  contextMode: AgentSessionContinuationContextMode | null
  onContextModeChange: (mode: AgentSessionContinuationContextMode) => void
  onClose: () => void
  /** Runs after the sheet has gone without a pick. */
  onClosed?: () => void
  /** Runs after the sheet has gone. */
  onPick: (option: MobileNewTabAgentOption) => void
}

/** Desktop's Hand off to agent, laid out like the New Tab sheet: one tap on an agent starts it. */
export function AgentHistoryHandoffSheet({
  visible,
  sessionTitle,
  agentOptions,
  agentStatusRow,
  contextMode,
  onContextModeChange,
  onClose,
  onClosed,
  onPick
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const pickedRef = useRef<MobileNewTabAgentOption | null>(null)
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        const picked = pickedRef.current
        pickedRef.current = null
        if (picked) {
          onPick(picked)
        } else {
          onClosed?.()
        }
      }}
      dragContentToDismiss
    >
      <SheetHeader
        title={t('agentHistory.handoff.title', 'Hand off to agent')}
        {...(sessionTitle ? { subtitle: sessionTitle } : {})}
        onClose={onClose}
      />
      {contextMode ? (
        <>
          <SectionHeader title={t('agentHistory.handoff.context', 'Context')} first />
          <MobileSegmentedControl
            segments={[
              {
                value: 'focused',
                label: t('agentHistory.handoff.latestStatus', 'Latest status')
              },
              { value: 'full', label: t('agentHistory.handoff.fullTranscript', 'Full transcript') }
            ]}
            selected={contextMode}
            onSelect={onContextModeChange}
            fill
            onSheet
            style={styles.context}
          />
        </>
      ) : null}
      <SectionHeader title={t('session.sheets.agents', 'Agents')} first={!contextMode} />
      {agentStatusRow ? (
        <ActionSheetContent actions={[agentStatusRow]} />
      ) : (
        <MobileAgentTileGrid
          options={agentOptions}
          showCliOnly={false}
          onPick={(option) => {
            pickedRef.current = option
            onClose()
          }}
        />
      )}
    </BottomDrawer>
  )
}

/** The sheet for one session, loading the target workspace's agents only while it is up. */
export function AgentHistoryHandoffDrawer({
  client,
  connState,
  hostId,
  hostCapabilities,
  worktreeId,
  ...sheet
}: Omit<Props, 'agentOptions' | 'agentStatusRow'> & {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  hostCapabilities: readonly string[] | undefined
  worktreeId: string
}) {
  const t = useMobileTranslation()
  const agents = useMobileNewTabAgentOptions({
    client,
    connState,
    hostId,
    hostCapabilities,
    worktreeId,
    open: sheet.visible,
    prefetch: false
  })
  return (
    <AgentHistoryHandoffSheet
      {...sheet}
      agentOptions={agents.options}
      agentStatusRow={mobileAgentLoadStatusRow({
        loadState: agents.loadState,
        optionCount: agents.options.length,
        errorHint: t('session.usePanelRouteActions.checkHostHint', 'Check the host connection'),
        t
      })}
    />
  )
}

const styles = themedStyleSheet(() => ({
  context: { marginBottom: spacing.sm }
}))
