import { getNativeChatAgentProfile } from '../../../src/shared/native-chat-agent-profiles'
import type { NativeChatComposerCatalog } from '../../../src/shared/native-chat-composer-catalog'
import {
  buildNativeChatPickerItems,
  type NativeChatPickerItem
} from '../../../src/shared/native-chat-picker-items'

export type MobileNativeChatSlashMenu = {
  /** Whether non-empty groups carry Commands / Skills headings (the session reports skills). */
  grouped: boolean
  commands: NativeChatPickerItem[]
  skills: NativeChatPickerItem[]
}

const EMPTY_MENU: MobileNativeChatSlashMenu = { grouped: false, commands: [], skills: [] }

/**
 * The phone's `/` menu rows for one query, built by the same row policy as the
 * desktop composer from the shared catalog selection. The phone does no disk
 * scan, so skills come only from the session's own report.
 */
export function mobileNativeChatSlashMenu(args: {
  agent: string | null | undefined
  /** `nativeChatComposerCatalog`'s answer for this agent and lane. */
  catalog: NativeChatComposerCatalog | null
  query: string
}): MobileNativeChatSlashMenu {
  const { agent, catalog, query } = args
  if (!agent || !catalog) {
    return EMPTY_MENU
  }
  const profile = getNativeChatAgentProfile(agent)
  const items = buildNativeChatPickerItems(
    catalog.agentCommands,
    [],
    query,
    profile?.skillPrefix ?? '/',
    profile ? catalog.sessionSkills : []
  )
  return {
    // Why: decided per catalog, not per query, so headings don't flicker as you type.
    grouped: profile !== null && (catalog.sessionSkills?.length ?? 0) > 0,
    commands: items.filter((item) => item.kind === 'command'),
    skills: items.filter((item) => item.kind === 'skill')
  }
}
