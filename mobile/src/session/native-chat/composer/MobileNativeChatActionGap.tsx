import { ComposerUsageSlot } from '../../../composer-usage/ComposerUsageMeter'
import { MobileNativeChatWidthToggle } from './MobileNativeChatWidthToggle'
import type { ChatWidthToggle } from './use-chat-bottom-fit'

/** The action row's flexible middle (usage meter), the context ring, and the Duo width toggle that closes it. */
export function MobileNativeChatActionGap({
  agent,
  ring,
  toggle
}: {
  agent: string | null
  ring: React.ReactNode
  toggle: ChatWidthToggle | null
}): React.JSX.Element {
  return (
    <>
      <ComposerUsageSlot agent={agent} spanSideStrip />
      {ring}
      {toggle ? <MobileNativeChatWidthToggle {...toggle} /> : null}
    </>
  )
}
