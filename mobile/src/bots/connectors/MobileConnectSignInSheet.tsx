// Linear's, GitHub's or Google's sign-in on the phone: the page open in Orca's browser on the computer, with
// only typing under it. The setup reopens once the sign-in ends.
import type { ComponentProps } from 'react'
import { View } from 'react-native'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { MobileBrowserTabBody } from '../../browser/MobileBrowserTabBody'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { TransientToast, useTransientToast } from '../../components/feedback/TransientToast'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { MobileBrowserTab } from '../../session/tabs/mobile-session-tabs'
import { themedStyleSheet } from '../../theme/themed-styles'

function pageHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

export function MobileConnectSignInSheet(
  props: Omit<
    ComponentProps<typeof MobileBrowserTabBody>,
    'tab' | 'keyboardLift' | 'bottomInset' | 'bare' | 'onToast' | 'pageOverlay'
  > & {
    /** The sign-in's tab; null while none shows. */
    tab: MobileBrowserTab | null
    source: 'linear' | 'github' | 'google'
    onCancel: () => void
  }
) {
  const t = useMobileTranslation()
  // The session's toast sits under this sheet's modal, so the page's notices show here.
  const { message, showToast } = useTransientToast()
  const { tab, source, onCancel, ...pane } = props
  return (
    <BottomDrawer
      visible={tab !== null}
      onClose={onCancel}
      fillAvailable
      contentScrollable={false}
      dragContentToDismiss={false}
    >
      {tab ? (
        <View style={styles.root}>
          <SheetHeader
            title={t('bots.connect.signInTo', 'Sign in to {{app}}', {
              app: BOT_CONNECTOR_NAMES[source]
            })}
            subtitle={pageHost(tab.url)}
            leading={{ label: t('common.cancel', 'Cancel'), onPress: onCancel }}
          />
          <View style={styles.page}>
            <MobileBrowserTabBody
              key={tab.browserPageId ?? tab.id}
              {...pane}
              tab={tab}
              bare
              onToast={showToast}
              pageOverlay={<TransientToast message={message} bottomInset={0} />}
              keyboardLift={0}
              bottomInset={0}
            />
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  root: { flex: 1 },
  page: { flex: 1, overflow: 'hidden' }
}))
