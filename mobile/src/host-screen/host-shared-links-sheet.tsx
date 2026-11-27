// Host ⋯ › Shared links: the paired computer's bot links, from its Orca account, each opening its
// bot's Share bot in the same sheet.
import { useState } from 'react'
import { View } from 'react-native'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { useBottomDrawerModalHostBackClaim } from '../components/bottom-drawer/bottom-drawer-modal-host-scope'
import { TransientToast, useTransientToast } from '../components/feedback/TransientToast'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ListedBot } from '../bots/host-bots-operations'
import { MobileLinkShareFlow } from '../bots/sharing/MobileBotSharing'
import { MobileSharedLinks, type SharedLinkOpen } from '../bots/sharing/MobileSharedLinks'
import type { HostScreenController } from './use-host-screen-controller'

const NO_BOTS: readonly ListedBot[] = []

type SheetProps = {
  controller: HostScreenController
  visible: boolean
  onClose: () => void
}

// iOS presents the drawer's pages in one Modal; Android's Back reaches them through the host.
export function HostSharedLinksSheet(props: SheetProps) {
  return (
    <BottomDrawerModalHost>
      <SharedLinksDrawer {...props} />
    </BottomDrawerModalHost>
  )
}

function SharedLinksDrawer(props: SheetProps) {
  const t = useMobileTranslation()
  const { bots, client, connState, state } = props.controller
  const listing = bots.find(
    (entry) => entry.kind === 'listed' && entry.hostId === LOCAL_EXECUTION_HOST_ID
  )
  const hostBots = listing?.kind === 'listed' ? listing.bots : NO_BOTS
  const online = connState === 'connected'
  const { message, showToast } = useTransientToast()
  const [opened, setOpened] = useState<SharedLinkOpen | null>(null)
  useBottomDrawerModalHostBackClaim(opened ? () => setOpened(null) : null)
  return (
    <BottomDrawer
      visible={props.visible}
      onClose={props.onClose}
      onAfterClose={() => setOpened(null)}
      scrollResetKey={opened?.share.id ?? null}
    >
      <View>
        {opened ? (
          <MobileLinkShareFlow
            client={client}
            bot={opened.bot}
            shareId={opened.share.id}
            hostName={state.hostName}
            online={online}
            banner={null}
            showToast={showToast}
            onBack={{
              label: t('bots.share.backToLinks', 'Back to Shared links'),
              onPress: () => setOpened(null)
            }}
          />
        ) : (
          <MobileSharedLinks
            key={props.visible ? 'open' : 'closed'}
            client={client}
            bots={hostBots}
            online={online}
            showToast={showToast}
            onOpen={setOpened}
            header={
              <SheetHeader
                title={t('settings.sharedLinks.title', 'Shared links')}
                subtitle={state.hostName}
                trailing={{ label: t('common.done', 'Done'), onPress: props.onClose }}
              />
            }
          />
        )}
        <TransientToast message={message} bottomInset={0} />
      </View>
    </BottomDrawer>
  )
}
