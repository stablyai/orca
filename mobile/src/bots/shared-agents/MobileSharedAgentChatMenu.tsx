// The shared agent's chat's "…": of the chat screen's menu, what applies to a chat with no workspace
// around it (its text size), with the same sheet.
import { useRef, useState } from 'react'
import type { HostInstance } from 'react-native'
import { ALargeSmall, MoreHorizontal } from 'lucide-react-native'
import { KeyedBottomDrawer } from '../../components/bottom-drawer/keyed-bottom-drawer'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useRouteHandoff } from '../../navigation/route-handoff'
import { ChatTextSheet } from '../../session/MobileSessionTextSizeSheet'

export function MobileSharedAgentChatMenu() {
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const anchor = useRef<HostInstance | null>(null)
  const [menu, setMenu] = useState(false)
  const [sheet, setSheet] = useState<'chat' | null>(null)
  return (
    <>
      <NavBarButton
        ref={anchor}
        icon={MoreHorizontal}
        accessibilityLabel={t('session.header.moreActions', 'More session actions')}
        active={menu}
        onPress={() => setMenu(true)}
      />
      <PullDownMenu
        visible={menu}
        anchorRef={anchor}
        groups={[
          [
            {
              id: 'textSize',
              label: t('session.header.textSize', 'Text size'),
              icon: ALargeSmall,
              closeBeforePress: true,
              onPress: () => setSheet('chat')
            }
          ]
        ]}
        onClose={() => setMenu(false)}
      />
      <KeyedBottomDrawer
        sheet={sheet}
        sheetKey={(kind) => kind}
        onClose={() => setSheet(null)}
        // The slider's drag would fight a drag-to-dismiss; the grabber still dismisses.
        contentScrollable={false}
        dimsBackground={false}
      >
        {() => (
          <ChatTextSheet
            onDone={() => setSheet(null)}
            onMore={() => {
              setSheet(null)
              router.push('/native-chat-settings')
            }}
          />
        )}
      </KeyedBottomDrawer>
    </>
  )
}
