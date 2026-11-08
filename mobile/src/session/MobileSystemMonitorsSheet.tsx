import { useEffect, useState, type JSX } from 'react'
import { Activity } from 'lucide-react-native'
import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'
import type { SystemMonitorDescriptor } from '../../../src/shared/system-monitors'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { MobileWorkspaceOnOtherRuntimeError } from './mobile-new-tab-agent-loader'
import {
  deleteCachedMobileSystemMonitors,
  getCachedMobileSystemMonitors,
  loadMobileSystemMonitors,
  setCachedMobileSystemMonitors
} from './mobile-system-monitors-loader'
import type { MobileSessionController } from './use-mobile-session-controller'

type MonitorSheetLoadState = 'idle' | 'loading' | 'loaded' | 'other-runtime' | 'error'

export function useMobileSystemMonitorsSheet(
  controller: Pick<
    MobileSessionController,
    | 'client'
    | 'connState'
    | 'hostId'
    | 'worktreeId'
    | 'showCreateTabDrawer'
    | 'handleCreateTerminal'
  >
): {
  systemMonitorsAction: ActionSheetAction
  systemMonitorsModal: JSX.Element
} {
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const workspaceKey = composeWorktreeHostIdentity(executionHost, controller.worktreeId)
  const [visible, setVisible] = useState(false)
  const [loadState, setLoadState] = useState<MonitorSheetLoadState>('idle')
  const [monitors, setMonitors] = useState<SystemMonitorDescriptor[]>([])

  const shouldProbe = controller.showCreateTabDrawer || visible
  const { client, connState, hostId, worktreeId } = controller

  useEffect(() => {
    if (!shouldProbe || !client || connState !== 'connected') {
      if (!visible) {
        setLoadState('idle')
      }
      return
    }
    let stale = false
    const cached = getCachedMobileSystemMonitors(hostId, workspaceKey)
    setLoadState(cached ? 'loaded' : 'loading')
    if (cached) {
      setMonitors(cached)
    }

    void loadMobileSystemMonitors({ client, worktreeId })
      .then((result) => {
        if (stale) {
          return
        }
        setCachedMobileSystemMonitors(hostId, workspaceKey, result.monitors)
        setMonitors(result.monitors)
        setLoadState('loaded')
      })
      .catch((error: unknown) => {
        if (stale) {
          return
        }
        const otherRuntime = error instanceof MobileWorkspaceOnOtherRuntimeError
        if (otherRuntime) {
          deleteCachedMobileSystemMonitors(hostId, workspaceKey)
        }
        if (otherRuntime || !cached) {
          setMonitors([])
          setLoadState(otherRuntime ? 'other-runtime' : 'error')
        }
      })

    return () => {
      stale = true
    }
  }, [client, connState, hostId, shouldProbe, visible, workspaceKey, worktreeId])

  const sheetActions: ActionSheetAction[] =
    loadState === 'loading' && monitors.length === 0
      ? [
          {
            id: 'detectingMonitors',
            label: t('session.sheets.detectingSystemMonitors', 'Detecting Monitors'),
            icon: Activity,
            disabled: true,
            loading: true,
            onPress: () => {}
          }
        ]
      : monitors.length > 0
        ? monitors.map((monitor) => ({
            id: `monitor:${monitor.id}`,
            label: monitor.label,
            hint:
              monitor.command === monitor.label
                ? monitor.categoryLabel
                : `${monitor.categoryLabel} · ${monitor.command}`,
            icon: Activity,
            onPress: () => {
              setVisible(false)
              void controller.handleCreateTerminal(undefined, {
                startupCommand: monitor.command,
                startupCommandDelivery: 'shell-ready'
              })
            }
          }))
        : loadState === 'other-runtime'
          ? [
              {
                id: 'otherServerMonitors',
                label: t('session.sheets.otherServerMonitors', 'Monitors on Another Server'),
                hint: t('session.usePanelRouteActions.pairServerHint', 'Pair that server directly'),
                icon: Activity,
                disabled: true,
                onPress: () => {}
              }
            ]
          : loadState === 'error'
            ? [
                {
                  id: 'monitorsUnavailable',
                  label: t('session.sheets.systemMonitorsUnavailable', 'Monitors Unavailable'),
                  hint: t(
                    'session.usePanelRouteActions.checkHostHint',
                    'Check the host connection'
                  ),
                  icon: Activity,
                  disabled: true,
                  onPress: () => {}
                }
              ]
            : [
                {
                  id: 'noSystemMonitors',
                  label: t('session.sheets.noSystemMonitors', 'No Monitors Detected'),
                  icon: Activity,
                  disabled: true,
                  onPress: () => {}
                }
              ]

  const systemMonitorsAction: ActionSheetAction = {
    id: 'systemMonitors',
    label: t('session.sheets.systemMonitors', 'Monitors (*top)'),
    icon: Activity,
    closeBeforePress: true,
    onPress: () => setVisible(true)
  }

  const systemMonitorsModal = (
    <ActionSheetModal
      visible={visible}
      title={t('session.sheets.systemMonitors', 'Monitors (*top)')}
      message={t(
        'session.sheets.systemMonitorsHint',
        'Launch an installed system or container monitor in a new terminal tab.'
      )}
      actions={sheetActions}
      onClose={() => setVisible(false)}
    />
  )

  return { systemMonitorsAction, systemMonitorsModal }
}
