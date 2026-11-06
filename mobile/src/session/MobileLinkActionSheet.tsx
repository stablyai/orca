import { useState } from 'react'
import { Copy, ExternalLink, Globe } from 'lucide-react-native'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { openExternalLink } from '../platform/external-link'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

// Choices for a tapped chat link: Orca's browser on the host, the phone's browser, or the clipboard.
export function MobileLinkActionSheet(props: {
  url: string
  // Called once the sheet has slid away; the URL stays on screen until then.
  onClose: () => void
  // Absent where an Orca browser tab cannot open (floating workspace, or a host without streaming).
  openInOrca?: (url: string) => void
}): React.JSX.Element {
  const { url, onClose, openInOrca } = props
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [visible, setVisible] = useState(true)
  const [copied, setCopied] = useState(false)
  const actions: ActionSheetAction[] = []
  if (openInOrca) {
    actions.push({
      id: 'openInOrca',
      label: t('session.linkActionSheet.openInOrca', 'Open in Orca browser'),
      icon: Globe,
      closeBeforePress: true,
      onPress: () => openInOrca(url)
    })
  }
  actions.push(
    {
      // The phone's default browser, whichever the person set.
      id: 'openInBrowser',
      label: t('session.linkActionSheet.openInBrowser', 'Open in system browser'),
      icon: ExternalLink,
      closeBeforePress: true,
      onPress: () => openExternalLink(url)
    },
    {
      id: 'copyLink',
      label: copied
        ? t('common.copied', 'Copied')
        : t('session.linkActionSheet.copyLink', 'Copy link'),
      icon: Copy,
      onPress: () => {
        void clipboard.writeText(url).then(
          () => {
            triggerSuccess()
            setCopied(true)
          },
          () => triggerError()
        )
      }
    }
  )
  return (
    <ActionSheetModal
      visible={visible}
      title={url}
      actions={actions}
      onClose={() => setVisible(false)}
      onAfterClose={onClose}
    />
  )
}
