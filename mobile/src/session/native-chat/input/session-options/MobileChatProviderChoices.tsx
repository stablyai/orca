import { useState } from 'react'
import { Alert } from 'react-native'
import { useOptionalHostProtocolGates } from '../../../../components/host-connection/host-protocol-gates-context'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileAgentTileGrid } from '../../../agent-launch/MobileAgentTileGrid'
import { useMobileNewTabAgentOptions } from '../../../agent-launch/use-mobile-new-tab-agent-options'
import { callAgentSession } from '../../agent-session/mobile-structured-agent-session-rpc'
import { isNativeChatAgent } from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-support'
import { tuiAgentDisplayName } from '../../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { AgentSessionSelectProviderResultSchema } from '../../../../../../src/shared/agent-session/lifecycle/records/agent-session-provider-selection'
import type { MobileChatProviderPickerScope } from './use-mobile-chat-provider-picker'

export function MobileChatProviderChoices({
  scope,
  active,
  onError
}: {
  scope: MobileChatProviderPickerScope
  active: string
  onError: (message: string) => void
}) {
  const t = useMobileTranslation()
  const status = useOptionalHostProtocolGates()
  const [pending, setPending] = useState(false)
  const { client, sessionId, worktreeId, hostId, selection } = scope
  const { options } = useMobileNewTabAgentOptions({
    client,
    hostId,
    worktreeId,
    connState: client.getState(),
    hostCapabilities: status?.hostCapabilities,
    open: true,
    prefetch: false
  })
  const pick = async (agent: string) => {
    if (pending || agent === (selection?.agent ?? active)) {
      return
    }
    setPending(true)
    try {
      const params = { sessionId, agent }
      const result = AgentSessionSelectProviderResultSchema.parse(
        await callAgentSession(client, 'agentSession.selectProvider', params)
      )
      if (result.status === 'consent-required') {
        const allowed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t('chat.providerSwitch.allowTitle', 'Let {{agent}} use tools without Orca approval?', {
              agent: tuiAgentDisplayName(agent) ?? agent
            }),
            t(
              'chat.providerSwitch.allowDescription',
              'Orca can’t require this agent to ask before using tools. The current reply and messages already queued keep their permissions.'
            ),
            [
              {
                text: t('common.cancel', 'Cancel'),
                style: 'cancel',
                onPress: () => resolve(false)
              },
              {
                text: t('chat.providerSwitch.allow', 'Allow and switch'),
                onPress: () => resolve(true)
              }
            ],
            { cancelable: true, onDismiss: () => resolve(false) }
          )
        })
        if (allowed) {
          const confirmed = AgentSessionSelectProviderResultSchema.parse(
            await callAgentSession(client, 'agentSession.selectProvider', {
              ...params,
              consent: {
                from: result.from,
                fromPermission: result.fromPermission,
                permission: 'full-access'
              }
            })
          )
          if (confirmed.status !== 'selected') {
            onError(
              t(
                'chat.providerSwitch.changed',
                'Chat permissions changed. Pick the agent again to continue.'
              )
            )
          }
        }
      }
    } catch {
      onError(t('chat.providerSwitch.failed', 'Couldn’t select this agent.'))
    } finally {
      setPending(false)
    }
  }
  return (
    <MobileAgentTileGrid
      options={options.filter(({ agent, cliOnly }) => !cliOnly && isNativeChatAgent(agent))}
      showCliOnly={false}
      selected={selection?.agent ?? active}
      onPick={({ agent }) => void pick(agent)}
    />
  )
}
