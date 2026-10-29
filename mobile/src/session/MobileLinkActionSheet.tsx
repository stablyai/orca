import { Copy, ExternalLink, Globe } from 'lucide-react-native'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { openExternalLink } from '../platform/external-link'
import { useClipboardWriter } from '../platform/clipboard'

// Choices for a tapped chat link: Orca's browser on the host, the phone's browser, or the clipboard.
export function MobileLinkActionSheet(props: {
  url: string | null
  onClose: () => void
  // Absent where an Orca browser tab cannot open (floating workspace, or a host without streaming).
  openInOrca?: (url: string) => void
  showToast: (message: string, durationMs?: number) => void
}): React.JSX.Element {
  const { url, onClose, openInOrca, showToast } = props
  const clipboard = useClipboardWriter()
  const actions: ActionSheetAction[] = []
  if (url !== null) {
    if (openInOrca) {
      actions.push({
        label: 'Open in Orca browser',
        icon: Globe,
        closeBeforePress: true,
        onPress: () => openInOrca(url)
      })
    }
    actions.push(
      {
        // The phone's default browser, which may not be Safari.
        label: 'Open in browser',
        icon: ExternalLink,
        closeBeforePress: true,
        onPress: () => openExternalLink(url)
      },
      {
        label: 'Copy link',
        icon: Copy,
        onPress: () =>
          void clipboard.writeText(url).then(
            () => showToast('Link copied', 1200),
            (error: unknown) =>
              showToast(error instanceof Error ? error.message : 'Could not copy the link', 1800)
          )
      }
    )
  }
  return (
    <ActionSheetModal
      visible={url !== null}
      title={url ?? 'Link'}
      actions={actions}
      onClose={onClose}
    />
  )
}
