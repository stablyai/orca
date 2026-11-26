import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import type { MobileNativeChatComposerProps } from './mobile-native-chat-composer-props'
import { useMobileNativeChatDraft } from './drafts/mobile-native-chat-draft-store'

export function MobileNativeChatDraftComposer({
  draftKey,
  ...props
}: Omit<MobileNativeChatComposerProps, 'value'> & { draftKey: string | null }): React.JSX.Element {
  return <MobileNativeChatComposer {...props} value={useMobileNativeChatDraft(draftKey)} />
}
