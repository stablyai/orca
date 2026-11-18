// The chat's Slack sheet on the phone: the desktop menu's switch, audience line and Open in Slack.
import { useEffect, useState } from 'react'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { ListRow } from '../../../components/list/ListGroup'
import { SwitchRow } from '../../../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { openExternalLink } from '../../../platform/external-links/external-link'
import type { SlackMirrorStatus } from '../../../../../src/shared/connectors/connector-slack-mirror-contract'
import {
  slackMirrorView,
  slackThreadUrl
} from '../../../../../src/shared/connectors/slack-mirror-state'
import type { MobileSlackMirror } from './use-mobile-slack-mirror'
import { useMobileSlackMirrorCopy } from './mobile-slack-mirror-copy'

export function MobileSlackMirrorSheet({
  mirror,
  open,
  onClose
}: {
  mirror: MobileSlackMirror | null
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const say = useMobileSlackMirrorCopy()
  const [status, setStatus] = useState<SlackMirrorStatus | null>(null)
  useEffect(() => {
    if (open && mirror) {
      void mirror.status().then((read) => read && setStatus(read))
    }
    // Read once per opening.
  }, [open])
  if (!mirror) {
    return null
  }
  const view = slackMirrorView(mirror.link, mirror.botName, status ?? undefined)
  const url = slackThreadUrl(mirror.link.externalId)
  return (
    <BottomDrawer visible={open} onClose={onClose}>
      <SheetHeader title={say(view.heading)} onClose={onClose} />
      <SwitchRow
        label={t('components.native-chat.slackMirror.switch', 'Post this chat to Slack')}
        detail={say(view.detail)}
        value={view.on}
        disabled={view.blocked !== null}
        onChange={(on) => void mirror.setOn(on)}
      />
      {url ? (
        <ListRow
          title={t('components.native-chat.connectorAsker.open', 'Open in {{source}}', {
            source: 'Slack'
          })}
          onPress={() => openExternalLink(url)}
        />
      ) : null}
    </BottomDrawer>
  )
}
