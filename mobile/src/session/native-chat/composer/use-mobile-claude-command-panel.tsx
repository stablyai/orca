import { useMemo, useState } from 'react'
import { Keyboard, View } from 'react-native'
import { ListGroup, ListRow } from '../../../components/list/ListGroup'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { readMobileNativeChatDraftInputs } from './mobile-native-chat-draft-inputs'
import { MobileNativeChatMcpPanel } from './MobileNativeChatMcpPanel'
import type { MobileNativeChatStructuredComposer } from './mobile-native-chat-structured-composer'
import type { MobileNativeChatSessionOptionPickersProps } from '../input/MobileNativeChatSessionOptionPickers'
import { spacing } from '../../../theme/mobile-theme'
import type { SlashCommandSuggestion } from '../../../../../src/shared/native-chat/input/native-chat-slash-commands'

export function useMobileClaudeCommandPanel(args: {
  agent: string | null
  draft: string
  surfaceId: string
  draftScopeKey?: string | null
  editing: boolean
  disabled: boolean
  offline: boolean
  structured: MobileNativeChatStructuredComposer | null
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  openOptions: (page: string) => void
}) {
  const t = useMobileTranslation()
  const [opened, setOpened] = useState<{ surfaceId: string; visible: boolean } | null>(null)
  const options = args.sessionOptions?.controller.snapshot ?? []
  const permission = options.find((entry) => entry.id === 'permissionMode' && entry.settable)
  const home =
    options.find((entry) => entry.category === 'model' && entry.settable) ??
    options.find((entry) => entry.settable)
  const hasMcp = args.structured?.mcp !== undefined
  const homeId = home?.id
  const permissionId = permission?.id
  const commands = useMemo<SlashCommandSuggestion[]>(
    () =>
      args.agent !== 'claude' || args.editing
        ? []
        : [
            ...(hasMcp
              ? [
                  {
                    name: 'mcp',
                    description: t('chat.commands.mcp', 'Manage MCP connections'),
                    orcaOwned: true as const
                  }
                ]
              : []),
            ...(homeId
              ? [
                  {
                    name: 'config',
                    description: t('chat.commands.config', 'Open session settings'),
                    orcaOwned: true as const
                  }
                ]
              : []),
            ...(permissionId
              ? [
                  {
                    name: 'permissions',
                    description: t('chat.commands.permissions', 'Open session permissions'),
                    orcaOwned: true as const
                  }
                ]
              : [])
          ],
    [args.agent, args.editing, hasMcp, homeId, permissionId, t]
  )
  const pickedSkills = readMobileNativeChatDraftInputs(args.draftScopeKey ?? args.surfaceId).skills
  const command = commands.find(
    (entry) =>
      args.draft.trim() === `/${entry.name}` &&
      !pickedSkills.some((skill) => skill.name === entry.name)
  )
  const open = () => {
    if (!command) {
      return false
    }
    if (args.disabled || args.offline) {
      return true
    }
    Keyboard.dismiss()
    if (command.name === 'mcp') {
      setOpened({ surfaceId: args.surfaceId, visible: true })
    } else {
      const page = command.name === 'permissions' ? permission?.id : home?.id
      if (page) {
        args.openOptions(page)
      }
    }
    return true
  }
  const mcp = args.structured?.mcp
  return {
    commands,
    consumesDraft: command !== undefined,
    open,
    panel: (
      <>
        {command && (
          <View style={{ marginHorizontal: spacing.md, marginBottom: spacing.sm }}>
            <ListGroup>
              <ListRow
                title={`/${command.name}`}
                subtitle={command.description}
                navigates
                disabled={args.disabled || args.offline}
                onPress={open}
              />
            </ListGroup>
          </View>
        )}
        {mcp && opened?.surfaceId === args.surfaceId && (
          <MobileNativeChatMcpPanel
            key={mcp.sessionKey}
            request={mcp.request}
            visible={opened.visible}
            offline={args.offline}
            onClose={() => setOpened((current) => current && { ...current, visible: false })}
          />
        )}
      </>
    )
  }
}
