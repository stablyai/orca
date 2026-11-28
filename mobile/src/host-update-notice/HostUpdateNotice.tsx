import { useCallback, useContext, useEffect } from 'react'
import { AccessibilityInfo } from 'react-native'
import { TransientToast } from '../components/feedback/TransientToast'
import { useGlobalSearchParams } from 'expo-router'
import { useRouteHandoff } from '../navigation/route-handoff'
import { firstParam } from '../navigation/route-param-reader'
import { CircleArrowUp } from 'lucide-react-native'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { useOptionalHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { ListRow } from '../components/list/ListGroup'
import { useHostProfile } from '../host-catalog/use-host-profile'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import { canUpdateOrcaFromPhone } from '../host-descriptors/host-orca-update-support'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { WorkspaceServerContext } from '../worktree/execution-hosts/workspace-server-context'

export type HostUpdateNoticeTarget = {
  /** "Update Orca on <name>": the computer, or the server a workspace runs on. */
  name: string
  /** Opens the update sheet, or Edit computer's steps; null for a server the computer updates. */
  action: { label: string; onPress: () => void } | null
}

/**
 * Who a "needs a newer Orca" refusal names and what its one action does. Inside a server
 * workspace it names that server, which its computer updates, so there is no phone action.
 */
export function useHostUpdateNoticeTarget(
  hostIdProp?: string,
  options: { computer?: boolean; hostName?: string } = {}
): HostUpdateNoticeTarget {
  const t = useMobileTranslation()
  // Screens under /h/[hostId] name their computer from the route.
  const routeHostId = firstParam(useGlobalSearchParams<{ hostId?: string | string[] }>().hostId)
  const hostId = hostIdProp ?? routeHostId
  // In a host-served page Edit computer is native, so the page hands the route to the shell.
  const router = useRouteHandoff()
  const server = useContext(WorkspaceServerContext)
  const gates = useOptionalHostProtocolGates()
  // A caller that already shows the computer's name passes it, so no catalog read repeats it.
  const profileName = useHostDisplay(useHostProfile(options.hostName ? '' : hostId)).title
  const computerName = options.hostName ?? profileName
  const onServer = server !== undefined && options.computer !== true
  // Inside a server workspace the route's gates are the server's; the computer's own are kept aside.
  const computerGates = server ? (server.desktopGates ?? null) : gates
  const phoneUpdates = computerGates
    ? canUpdateOrcaFromPhone(computerGates.hostCapabilities, computerGates.hostUpdateSupport)
    : false
  const open = useCallback(() => {
    // Edit computer opens the sheet only when the computer takes the update from a phone.
    router.push(`/h/${encodeURIComponent(hostId)}/edit?update=orca`)
  }, [router, hostId])
  if (onServer) {
    return { name: server.name ?? computerName, action: null }
  }
  return {
    name: computerName,
    action: {
      label: phoneUpdates
        ? t('host.updateNotice.update', 'Update')
        : t('host.updateNotice.howToUpdate', 'How to update'),
      onPress: open
    }
  }
}

/** The one notice for a feature this computer's Orca is too old for: a whole screen, or a row. */
export function HostUpdateNotice(props: {
  /** Defaults to the computer the route is under. */
  hostId?: string
  /** The feature in a few words, e.g. "Source control needs a newer version." */
  feature: string
  variant: 'screen' | 'row'
  /** Names the paired computer even inside a server workspace, e.g. when it relays the feature. */
  computer?: boolean
  /** The computer's name when the screen already has it. */
  hostName?: string
  bottomInset?: number
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const target = useHostUpdateNoticeTarget(props.hostId, {
    ...(props.computer ? { computer: true } : {}),
    ...(props.hostName ? { hostName: props.hostName } : {})
  })
  const title = t('host.updateNotice.title', 'Update Orca on {{host}}', { host: target.name })
  if (props.variant === 'row') {
    return (
      <ListRow
        title={title}
        wrapTitle
        subtitle={props.feature}
        leading={<CircleArrowUp size={18} color={colors.accentBlue} />}
        {...(target.action ? { navigates: true, onPress: target.action.onPress } : {})}
      />
    )
  }
  return (
    <MobileStateView
      icon={CircleArrowUp}
      title={title}
      message={props.feature}
      action={target.action}
      {...(props.bottomInset !== undefined ? { bottomInset: props.bottomInset } : {})}
    />
  )
}

/** The toast line for a one-off refusal (delete a workspace, accept a certificate), with its action. */
export function useHostUpdateToast(hostId?: string): {
  message: string
  action: HostUpdateNoticeTarget['action']
} {
  const t = useMobileTranslation()
  const target = useHostUpdateNoticeTarget(hostId)
  return {
    message: t('host.updateNotice.toast', 'Needs a newer Orca on {{host}}', { host: target.name }),
    action: target.action
      ? { ...target.action, label: t('host.updateNotice.update', 'Update') }
      : null
  }
}

// As long as an action toast stays elsewhere on the phone.
const HOST_UPDATE_TOAST_MS = 5_000

/** A one-off refusal (delete a workspace, accept a certificate) as a toast with Update, not a dialog. */
export function HostUpdateToast(props: {
  visible: boolean
  onDismiss: () => void
  bottomInset: number
  hostId?: string
}) {
  // Mounted on screens that rarely refuse; nothing is read until a refusal shows it.
  return props.visible ? (
    <VisibleHostUpdateToast
      onDismiss={props.onDismiss}
      bottomInset={props.bottomInset}
      {...(props.hostId ? { hostId: props.hostId } : {})}
    />
  ) : null
}

function VisibleHostUpdateToast(props: {
  onDismiss: () => void
  bottomInset: number
  hostId?: string
}) {
  const { message, action } = useHostUpdateToast(props.hostId)
  const { onDismiss } = props
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message)
    const timer = setTimeout(onDismiss, HOST_UPDATE_TOAST_MS)
    return () => clearTimeout(timer)
  }, [onDismiss, message])
  return (
    <TransientToast
      message={message}
      action={
        action
          ? {
              label: action.label,
              onPress: () => {
                onDismiss()
                action.onPress()
              }
            }
          : null
      }
      bottomInset={props.bottomInset}
    />
  )
}
