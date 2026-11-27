import { useMemo } from 'react'
import { prepareQueuedMessageEditText } from '../../../../../../src/shared/native-chat/input/queued-messages/queued-message-edit-command'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../../src/shared/native-chat/input/composer/native-chat-picker-items'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import {
  mobileComposerCatalog,
  type MobileComposerCatalog,
  type MobileComposerStructuredCatalog
} from './mobile-native-chat-composer-menu'

/** The composer's commands and skills, and while editing, which commands the edit may hold. */
export function useMobileNativeChatComposerCatalog(input: {
  agent: string | null
  structuredCatalog: MobileComposerStructuredCatalog | undefined
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  editing?: boolean
  interactionModeSupported?: boolean
  hostSetsGoals?: boolean
}): {
  catalog: MobileComposerCatalog
  commandAvailable: ((name: string) => boolean) | undefined
} {
  const { agent, structuredCatalog, skillDiscovery } = input
  const t = useMobileTranslation()
  const reported = structuredCatalog?.reported
  const acceptsText = useMemo(
    () =>
      prepareQueuedMessageEditText(
        agent ?? 'codex',
        reported,
        input.hostSetsGoals === true,
        input.interactionModeSupported === true,
        structuredCatalog?.mcpPanel === true
      ),
    [
      agent,
      reported,
      input.hostSetsGoals,
      input.interactionModeSupported,
      structuredCatalog?.mcpPanel
    ]
  )
  const commandAvailable = useMemo(
    () => (input.editing ? (name: string) => acceptsText(`/${name}`) : undefined),
    [input.editing, acceptsText]
  )
  const catalog = useMemo(
    () =>
      mobileComposerCatalog({
        agent,
        structured: structuredCatalog,
        discovery: skillDiscovery,
        interactionModeSupported: input.interactionModeSupported,
        t
      }),
    [agent, skillDiscovery, structuredCatalog, input.interactionModeSupported, t]
  )
  return { catalog, commandAvailable }
}
