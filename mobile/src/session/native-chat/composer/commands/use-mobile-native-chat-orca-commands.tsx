import { useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { tuiAgentDisplayName } from '../../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { translate } from '../../../../i18n/mobile-i18n'
import { MobileNativeChatForkContext } from '../../history/use-mobile-native-chat-fork'
import { MobileNativeChatAccountUsageSheet } from '../../usage/MobileNativeChatAccountUsageSheet'
import {
  forgetMobileNativeChatSkillOrigin,
  readMobileNativeChatSkillOrigin
} from '../drafts/mobile-native-chat-draft-store'
import {
  isMobileDesktopOnlyCommand,
  mobileDesktopOnlyCommandNotice,
  type MobileComposerStructuredCatalog
} from '../menus/mobile-native-chat-composer-menu'
import type { MobileNativeChatStructuredComposer } from './mobile-native-chat-structured-composer'

const NO_SUBSCRIPTION = () => () => {}

function forkNotice(outcome: 'pending' | 'working' | 'none', agent: string | null): string {
  switch (outcome) {
    case 'pending':
      return translate('components.native-chat.fork.pending', 'Forking this chat…')
    case 'working':
      return translate(
        'components.native-chat.fork.commandWorking',
        'Can’t fork while {{agent}} is replying. Run /fork again when it finishes.',
        { agent: (agent ? tuiAgentDisplayName(agent) : null) ?? agent ?? 'the agent' }
      )
    case 'none':
      return translate(
        'components.native-chat.fork.commandNothing',
        'There’s no response to fork yet.'
      )
  }
}

/** A structured chat's Orca commands, run by the composer before a send as desktop's are:
 *  `/fork` and `/usage` run here, `/resume`, `/side` and `/btw` are refused, never sent as text. */
export function useMobileNativeChatOrcaCommands(input: {
  structured: MobileNativeChatStructuredComposer | null
  agent: string | null
  /** Where a picked skill's origin is recorded, so a skill named like an Orca command still reaches the agent. */
  sendSurfaceId: string
  /** A queued message's edit runs no commands. */
  editing: boolean
  clearDraft: () => void
}) {
  const { structured, agent, sendSurfaceId, editing, clearDraft } = input
  const fork = useContext(MobileNativeChatForkContext)
  const forkOffered = useSyncExternalStore(
    fork?.subscribe ?? NO_SUBSCRIPTION,
    () => fork?.commandOffered() ?? false
  )
  const accountUsage = structured?.accountUsage ?? null
  const [usageOpenFor, setUsageOpenFor] = useState<typeof accountUsage>(null)
  const baseCatalog = structured?.catalog
  const catalog = useMemo<MobileComposerStructuredCatalog | undefined>(
    () =>
      baseCatalog && !editing
        ? { ...baseCatalog, fork: forkOffered, accountUsage: accountUsage !== null }
        : baseCatalog,
    [accountUsage, baseCatalog, editing, forkOffered]
  )

  const notice = (message: string): true => {
    structured?.onCommandNotice?.(message)
    return true
  }
  const name = (token: string): string => token.replace(/^\//, '').toLowerCase()
  const isPickedSkill = (token: string): boolean =>
    readMobileNativeChatSkillOrigin(sendSurfaceId) === token

  /** True when the draft was an Orca command; the draft clears only when it ran. */
  const consume = (draft: string): boolean => {
    const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim())
    if (!match || editing || !catalog || isPickedSkill(match[1]!)) {
      return false
    }
    const command = name(match[1]!)
    const rest = match[2]?.trim() ?? ''
    if (isMobileDesktopOnlyCommand(command, catalog)) {
      return notice(mobileDesktopOnlyCommandNotice(translate))
    }
    if (command === 'usage' && accountUsage && !rest) {
      setUsageOpenFor(accountUsage)
      clearDraft()
      return true
    }
    if (command === 'fork' && fork && forkOffered) {
      // A message after /fork has nowhere to go yet; dropping it silently would lose it.
      if (rest) {
        return notice(
          translate(
            'components.native-chat.fork.commandTakesNoText',
            'Send /fork on its own, then write in the new chat.'
          )
        )
      }
      const outcome = fork.forkLatest()
      if (outcome !== 'started') {
        return notice(forkNotice(outcome, agent))
      }
      clearDraft()
      return true
    }
    return false
  }

  return {
    catalog,
    consume,
    onPickCommand: (token: string): void => forgetMobileNativeChatSkillOrigin(sendSurfaceId, token),
    /** A picked desktop-only row inserts nothing and says why, as Send does. */
    refusesPick: (token: string): boolean =>
      isMobileDesktopOnlyCommand(name(token), catalog) &&
      notice(mobileDesktopOnlyCommandNotice(translate)),
    usageSheet: accountUsage ? (
      <MobileNativeChatAccountUsageSheet
        usage={usageOpenFor ?? accountUsage}
        open={usageOpenFor === accountUsage}
        onClose={() => setUsageOpenFor(null)}
      />
    ) : null
  }
}
