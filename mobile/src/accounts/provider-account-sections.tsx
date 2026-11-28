import { View } from 'react-native'
import type { AccountsSnapshot } from './accounts-snapshot'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { getProviderDisplayName } from '../../../src/shared/agent-usage/display/usage-provider-windows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { ProviderUsageWindows } from './ProviderUsageWindows'
import { UsageStatusNote } from './usage/UsageStatusNote'
import { getOtherUsageProviders } from './usage/usage-selectors'
import {
  ManagedDataAccountSection,
  managedDataBusyId,
  type ManagedDataProvider
} from './managed-data-account-section'
import {
  AntigravityAccountSection,
  antigravityBusyId,
  requestAntigravitySelect,
  useProviderAccountSwitch
} from './antigravity-account-section'
import { selectDataAccount } from './provider-account-operations'

/** The sections after Claude and Codex: OpenCode and Devin profiles, saved Antigravity accounts, and every other provider's usage. */
export function ProviderAccountSections({
  client,
  live,
  snapshot,
  now,
  reloadKey,
  busyAccountId,
  switchBlocked,
  onBusyAccountId,
  onSwitched,
  onNotice
}: {
  client: RpcClient | null
  live: boolean
  snapshot: AccountsSnapshot | null
  now: number
  reloadKey: number
  busyAccountId: string | null
  switchBlocked: boolean
  onBusyAccountId: (id: string | null) => void
  onSwitched: () => Promise<void>
  onNotice: (notice: { title: string; message: string }) => void
}) {
  const t = useMobileTranslation()
  const accountSwitch = useProviderAccountSwitch(client, live, reloadKey)
  if (!snapshot) {
    return null
  }

  const runSwitch = async (busyId: string, run: (client: RpcClient) => Promise<void>) => {
    if (!client) {
      return
    }
    onBusyAccountId(busyId)
    try {
      await run(client)
      await onSwitched()
    } catch (e) {
      onNotice({
        title: t('accounts.screen.switchFailed', 'Could not switch account'),
        message: e instanceof Error ? e.message : String(e)
      })
    } finally {
      onBusyAccountId(null)
    }
  }
  const selectManagedData = (provider: ManagedDataProvider, accountId: string | null) =>
    void runSwitch(managedDataBusyId(provider, accountId), async (rpc) => {
      selectDataAccount.interpret(await selectDataAccount.request(rpc, { provider, accountId }))
    })
  const selectAntigravity = (accountId: string) =>
    void runSwitch(antigravityBusyId(accountId), async (rpc) => {
      accountSwitch.replaceAntigravity(await requestAntigravitySelect(rpc, accountId))
    })

  const others = getOtherUsageProviders(snapshot)
  return (
    <>
      {accountSwitch.supported
        ? (['opencode', 'devin'] as const).map((provider) => (
            <ManagedDataAccountSection
              key={provider}
              provider={provider}
              snapshot={snapshot}
              busyAccountId={busyAccountId}
              switchBlocked={switchBlocked}
              onSelect={selectManagedData}
            />
          ))
        : null}
      <AntigravityAccountSection
        state={accountSwitch.antigravity}
        busyAccountId={busyAccountId}
        switchBlocked={switchBlocked}
        onSelect={selectAntigravity}
      />
      {/* Usage only; these accounts are managed on desktop. */}
      {others.length > 0 ? (
        <View>
          <SectionHeader title={t('accounts.screen.otherAgents', 'Other agents')} />
          <ListGroup>
            {others.map((limits) => (
              <ListRow
                key={limits.provider}
                title={getProviderDisplayName(limits.provider)}
                leading={<MobileAgentIcon agentId={limits.provider} size={16} />}
                detail={
                  <>
                    <ProviderUsageWindows limits={limits} now={now} />
                    <UsageStatusNote limits={limits} />
                  </>
                }
              />
            ))}
          </ListGroup>
        </View>
      ) : null}
    </>
  )
}
