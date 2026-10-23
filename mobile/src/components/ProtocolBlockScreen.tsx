import { useWallAppUpdate } from '../app-update/use-wall-app-update'
import { openExternalLink } from '../platform/external-link'
import { useRouteHandoff } from '../navigation/route-handoff'
import { Platform } from 'react-native'
import { ArrowUpCircle } from 'lucide-react-native'
import { ShellStateFrame, ShellStateMessage } from '../mobile-web-shell/ShellStateFrame'
import type { CompatVerdict } from '../transport/protocol-compat'
import type { MobileWebBundleCompatVerdict } from '../transport/mobile-web-bundle-compat'
import type { PageRouteRefusalVerdict } from '../mobile-web-shell/page-route-policy'

const RELEASES_URL = 'https://github.com/stablyai/orca/releases'
const IOS_APP_STORE_URL = 'itms-apps://apps.apple.com/app/orca-ide/id6766130217'

/** Every wall this screen renders: the protocol one, the bundle one and the page route one. All are
 *  terminal — there is no native workspace to fall back to, so the only way out is updating one of
 *  the two apps. */
export type BlockedVerdict =
  | Extract<CompatVerdict, { kind: 'blocked' }>
  | Extract<MobileWebBundleCompatVerdict, { kind: 'blocked' }>
  | PageRouteRefusalVerdict

type Props = {
  verdict: BlockedVerdict
  /** The desktop's name for the bar, when the caller has it. */
  hostName?: string
}

const DESKTOP_TOO_OLD_BODY =
  'This paired desktop app is too old for your current Orca Mobile app. Update Orca on your computer, then open this desktop again.'

/** What clears the wall. `refresh-bundle` is the one that no store can: the cached workspace is
 *  older than this host's client floor, so a download fixes it and an app update does not. */
type BlockRemedy = 'update-mobile' | 'update-desktop' | 'refresh-bundle'

function blockRemedy(verdict: BlockedVerdict): BlockRemedy {
  switch (verdict.reason) {
    case 'mobile-too-old':
    case 'bundle-shell-too-old':
    case 'page-route-grant-missing':
      return 'update-mobile'
    case 'desktop-too-old':
    case 'bundle-unavailable':
    case 'page-route-unlisted':
      return 'update-desktop'
    case 'bundle-incompatible':
      return verdict.side === 'desktop' ? 'update-desktop' : 'refresh-bundle'
  }
}

function blockTitle(remedy: BlockRemedy): string {
  switch (remedy) {
    case 'update-mobile':
      return 'Update Orca Mobile'
    case 'update-desktop':
      return 'Update Orca on your computer'
    case 'refresh-bundle':
      return 'Refresh the mobile workspace'
  }
}

function blockBody(verdict: BlockedVerdict, remedy: BlockRemedy, storeName: string): string {
  if (remedy === 'refresh-bundle') {
    return 'The workspace saved on this phone is older than the desktop expects. Reconnect to this desktop to download the current one.'
  }
  if (verdict.reason === 'mobile-too-old') {
    return `This desktop needs a newer Orca Mobile app. Update Orca Mobile from ${storeName}, then open this desktop again.`
  }
  if (remedy === 'update-mobile') {
    return `This desktop's mobile workspace needs a newer Orca Mobile app. Update Orca Mobile from ${storeName}, then open this desktop again.`
  }
  return DESKTOP_TOO_OLD_BODY
}

export function ProtocolBlockScreen({ verdict, hostName }: Props) {
  const router = useRouteHandoff()
  const mobileUpdate = useWallAppUpdate()
  const remedy = blockRemedy(verdict)
  // Why: Android APKs ship through GitHub Releases until a Play Store listing exists.
  const mobileUpdateTarget =
    Platform.OS === 'ios'
      ? { label: 'Open App Store', url: IOS_APP_STORE_URL, storeName: 'the App Store' }
      : { label: 'Open GitHub Releases', url: RELEASES_URL, storeName: 'GitHub Releases' }
  const mobileAction = mobileUpdate
    ? { label: `Get Orca ${mobileUpdate.version}`, url: mobileUpdate.url }
    : { label: mobileUpdateTarget.label, url: mobileUpdateTarget.url }
  // No download to offer when the fix is a refetch: reconnecting is what this screen leaves you to do.
  const primaryAction =
    remedy === 'refresh-bundle'
      ? null
      : remedy === 'update-mobile'
        ? mobileAction
        : { label: 'Open GitHub Releases', url: RELEASES_URL }

  const title = blockTitle(remedy)
  const body = blockBody(verdict, remedy, mobileUpdateTarget.storeName)
  const recoveryNote =
    remedy === 'refresh-bundle'
      ? 'If this keeps showing, remove this desktop and pair it again.'
      : 'Already updated? Go back and reconnect. If this keeps showing, remove this desktop and pair it again.'

  // The handoff, not expo-router's singleton: `/` is the phone's home screen and the page does not
  // carry it, so inside the shell a singleton replace renders the root route in the WebView rather
  // than leaving it. This posts the target to the shell.
  const leave = () => router.replace('/')
  const back = { label: 'Back to desktops', onPress: leave }

  return (
    <ShellStateFrame title={hostName} onBack={leave} backAccessibilityLabel="Back to desktops">
      <ShellStateMessage
        icon={ArrowUpCircle}
        title={title}
        message={body}
        note={recoveryNote}
        primary={
          primaryAction
            ? {
                label: primaryAction.label,
                // The seam: this screen is in the tasks page closure, where react-native's `openURL`
                // calls a `window.open` both shells refuse and resolves anyway.
                onPress: () => openExternalLink(primaryAction.url)
              }
            : back
        }
        secondary={primaryAction ? back : undefined}
      />
    </ShellStateFrame>
  )
}
