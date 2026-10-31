import { ComposerUsageSlot } from '../../../composer-usage/ComposerUsageMeter'
import { MobileNativeChatWidthToggle } from './MobileNativeChatWidthToggle'
import type { ChatWidthToggle } from './use-chat-bottom-fit'

/** The action row's flexible middle (usage meter) and the Duo width toggle that closes it. */
export function MobileNativeChatActionGap({
  agent,
  toggle
}: {
  agent: string | null
  toggle: ChatWidthToggle | null
}): React.JSX.Element {
  return (
    <>
      <ComposerUsageSlot agent={agent} />
      {toggle ? <MobileNativeChatWidthToggle {...toggle} /> : null}
    </>
  )
}
