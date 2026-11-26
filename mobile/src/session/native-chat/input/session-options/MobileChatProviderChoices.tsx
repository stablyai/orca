import { chatSwitchPermissionCopy } from '../../../../../../src/shared/agent-session/options/permissions/provider-switch-permission-copy'
import { useState, type ReactNode } from 'react'
import { ConfirmContent } from '../../../../components/sheets/ConfirmModal'
import { ListGroup, ListRow, SectionHeader } from '../../../../components/list/ListGroup'
import type { BotModelChoices } from '../../../../bots/use-bot-model-choices'
import { useOptionalHostProtocolGates } from '../../../../components/host-connection/host-protocol-gates-context'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileAgentTileGrid } from '../../../agent-launch/MobileAgentTileGrid'
import { useMobileNewTabAgentOptions } from '../../../agent-launch/use-mobile-new-tab-agent-options'
import { callAgentSession } from '../../agent-session/mobile-structured-agent-session-rpc'
import { isNativeChatAgent } from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-support'
import { tuiAgentDisplayName } from '../../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { AgentSessionSelectProviderResultSchema } from '../../../../../../src/shared/agent-session/lifecycle/records/agent-session-provider-selection'
import type { AgentSessionSelectProviderParams } from '../../../../../../src/shared/agent-session/lifecycle/records/agent-session-provider-selection'
import type { MobileChatProviderPickerScope } from './use-mobile-chat-provider-picker'
import { SessionOptionCaption } from './MobileNativeChatSessionOptionRows'

export function MobileChatProviderChoices({
  scope,
  active,
  catalog,
  children
}: {
  scope: MobileChatProviderPickerScope
  active: string
  catalog: BotModelChoices | null
  children: ReactNode
}) {
  const t = useMobileTranslation()
  const status = useOptionalHostProtocolGates()
  const [pending, setPending] = useState(false)
  const [moreModels, setMoreModels] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<
    | (AgentSessionSelectProviderParams & {
        consent: NonNullable<AgentSessionSelectProviderParams['consent']>
      })
    | null
  >(null)
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
  const select = async (params: AgentSessionSelectProviderParams) => {
    if (pending) {
      return
    }
    setPending(true)
    setError(null)
    try {
      const result = AgentSessionSelectProviderResultSchema.parse(
        await callAgentSession(client, 'agentSession.selectProvider', params)
      )
      if (result.status === 'consent-required') {
        if (params.consent) {
          setError(
            t(
              'chat.providerSwitch.changed',
              'Chat permissions changed. Pick the agent again to continue.'
            )
          )
          return
        }
        setConfirming({
          ...params,
          consent: {
            from: result.from,
            fromPermission: result.fromPermission,
            permission: 'full-access'
          }
        })
      }
    } catch {
      setError(t('chat.providerSwitch.failed', 'Couldn’t select this agent.'))
    } finally {
      setPending(false)
    }
  }
  const pick = (agent: string, choices?: Record<string, string>) => {
    if (choices || agent !== (selection?.agent ?? active)) {
      void select({ sessionId, agent, ...(choices ? { options: choices } : {}) })
    }
  }
  if (confirming) {
    return (
      <ConfirmContent
        title={t(
          'chat.providerSwitch.closestPermissionTitle',
          'Use the closest permission on {{agent}}?',
          { agent: tuiAgentDisplayName(confirming.agent) ?? confirming.agent }
        )}
        message={chatSwitchPermissionCopy(
          confirming.consent.from,
          confirming.consent.fromPermission,
          confirming.agent,
          t
        )}
        confirmLabel={t('chat.providerSwitch.allow', 'Allow and switch')}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null)
          void select(confirming)
        }}
      />
    )
  }
  const extraModels =
    catalog?.models.filter((model) => model.isLegacy && model.id !== catalog.modelId) ?? []
  return (
    <>
      <MobileAgentTileGrid
        options={options.filter(({ agent, cliOnly }) => !cliOnly && isNativeChatAgent(agent))}
        showCliOnly={false}
        selected={selection?.agent ?? active}
        onPick={({ agent }) => {
          setMoreModels(false)
          void pick(agent)
        }}
      />
      {error ? <SessionOptionCaption>{error}</SessionOptionCaption> : null}
      {selection && catalog && catalog.models.length > 0 ? (
        <>
          <SectionHeader title={t('bots.settings.model', 'Model')} />
          <ListGroup>
            {catalog.models
              .filter((model) => moreModels || !model.isLegacy || model.id === catalog.modelId)
              .map((model) => (
                <ListRow
                  key={model.id}
                  title={model.label}
                  subtitle={model.description}
                  selected={model.id === catalog.modelId}
                  disabled={pending}
                  onPress={() => void pick(selection.agent, { model: model.id })}
                />
              ))}
            {extraModels.length > 0 && !moreModels ? (
              <ListRow
                title={t('chat.providerSwitch.moreModels', 'More models ({{count}})', {
                  count: extraModels.length
                })}
                onPress={() => setMoreModels(true)}
                navigates
              />
            ) : null}
          </ListGroup>
          {catalog.effort ? (
            <>
              <SectionHeader title={t('bots.settings.effort', 'Effort')} />
              <ListGroup>
                {catalog.effort.option.kind.choices.map(({ value, label }) => (
                  <ListRow
                    key={value}
                    title={label}
                    selected={value === catalog.effort?.value}
                    disabled={pending}
                    onPress={() =>
                      void pick(selection.agent, {
                        ...selection.options,
                        ...(catalog.modelId ? { model: catalog.modelId } : {}),
                        effort: value
                      })
                    }
                  />
                ))}
              </ListGroup>
            </>
          ) : null}
        </>
      ) : null}
      {children}
    </>
  )
}
