import { useEffect, useState } from 'react'
import { ActivityIndicator, AppState, Text, View } from 'react-native'
import { PickerModal } from '../components/sheets/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { CommanderMobileData } from './commander-mobile-data'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { runRpcOperation } from '../transport/rpc/rpc-operation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MemoryButton, s } from './phone-memory-controls'
import { phoneStatusRead, type PhoneStatus } from './phone-memory-rpc'
import { PhoneMemoryLibrary } from './PhoneMemoryLibrary'

export function PhoneMemory({
  data,
  active,
  hostScoped,
  handoffs
}: {
  data: CommanderMobileData
  active: boolean
  hostScoped?: boolean
  handoffs?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [selectedHost, setPicked] = useState<string | null>(() =>
    data.sortedHosts.length === 1 ? data.sortedHosts[0].id : null
  )
  const [selecting, setSelecting] = useState(false)
  const [editing, setEditing] = useState(false)
  const { sortedHosts, hostStates, allClients } = data
  const picked = hostScoped && sortedHosts.length === 1 ? sortedHosts[0].id : selectedHost
  const host = sortedHosts.find((entry) => entry.id === picked)
  const client =
    host && hostStates[host.id] === 'connected'
      ? allClients.find((entry) => entry.hostId === picked)?.client
      : null
  const selectLabel = t('commander.memoryDesktop', 'Choose desktop')
  return (
    <View style={s.fill}>
      {!(hostScoped && sortedHosts.length === 1) && (
        <View style={s.stack}>
          <MemoryButton
            label={host?.name ?? selectLabel}
            onPress={() => setSelecting(true)}
            disabled={editing || !sortedHosts.length}
          />
        </View>
      )}
      <PickerModal
        visible={active && selecting}
        title={selectLabel}
        options={sortedHosts.map((h) => ({ value: h.id, label: h.name }))}
        selected={picked ?? ''}
        onSelect={setPicked}
        onClose={() => setSelecting(false)}
      />
      {client && host ? (
        <PairedMemory
          hostId={host.id}
          hostScoped={hostScoped}
          handoffs={handoffs}
          key={host.id}
          client={client}
          active={active}
          setEditing={setEditing}
        />
      ) : (
        <View style={s.stack}>
          <Text style={s.meta}>
            {host
              ? t('commander.memoryOffline', 'Reconnect this desktop to open its account memory.')
              : t(
                  'commander.memoryPair',
                  'Select a connected, paired desktop to open account memory.'
                )}
          </Text>
        </View>
      )}
    </View>
  )
}

function PairedMemory({
  hostId,
  hostScoped,
  handoffs,
  client,
  active,
  setEditing
}: {
  hostId: string
  hostScoped?: boolean
  handoffs?: boolean
  client: RpcClient
  active: boolean
  setEditing: (value: boolean) => void
}) {
  const t = useMobileTranslation()
  const [status, setStatus] = useState<PhoneStatus | null>(null)
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [foreground, setForeground] = useState(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive'
  )
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active')
      setVerified(false)
    })
    return () => sub.remove()
  }, [])
  useEffect(() => {
    setVerified(false)
    if (!active || !foreground) {
      return
    }
    let live = true
    let pending = false
    async function check() {
      if (pending) {
        return
      }
      pending = true
      try {
        const current = await runRpcOperation(client, phoneStatusRead)
        if (live) {
          setStatus((previous) =>
            JSON.stringify(previous) === JSON.stringify(current) ? previous : current
          )
          setVerified(true)
          setError('')
        }
      } catch (err) {
        if (live) {
          setVerified(false)
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        pending = false
      }
    }
    void check()
    const timer = setInterval(() => void check(), 15_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active, foreground, attempt, client])
  const allowed = status?.state === 'enabled'
  const show = verified && allowed && active && foreground
  return (
    <View style={s.fill}>
      {allowed && (
        <View style={show ? s.fill : s.hidden}>
          {handoffs && !status.handoffs ? (
            <Text style={s.meta}>
              {t(
                'commander.handoffUpdateHost',
                'Update Orca on this desktop to use account handoffs.'
              )}
            </Text>
          ) : (
            <PhoneMemoryLibrary
              hostHandoffs={status.handoffs === true}
              handoffSearch={status.handoffSearch === true}
              key={JSON.stringify([
                status.account.profileId,
                status.account.userId,
                status.account.activeOrgId
              ])}
              hostId={hostId}
              hostScoped={hostScoped}
              handoffs={handoffs}
              client={client}
              account={status.account}
              active={show}
              setEditing={setEditing}
              onAccessError={() => {
                setStatus(null)
                setVerified(false)
                setAttempt((a) => a + 1)
              }}
            />
          )}
        </View>
      )}
      {(!verified || !allowed) && active && foreground && (
        <View style={s.stack}>
          {error ? (
            <>
              <Text accessibilityRole="alert" style={s.meta}>
                {/method.not.found|unknown method/i.test(error)
                  ? t(
                      'commander.memoryUpdate',
                      'Update your paired desktop to a version with Commander Memory.'
                    )
                  : error}
              </Text>
              <MemoryButton
                label={t('common.retry', 'Retry')}
                onPress={() => setAttempt((a) => a + 1)}
              />
            </>
          ) : !verified ? (
            <ActivityIndicator accessibilityLabel={t('commander.memoryLoading', 'Loading…')} />
          ) : (
            <Text style={s.meta}>
              {status?.state === 'disabled'
                ? t(
                    'commander.memorySharing',
                    'On this desktop, open Commander → Memory and enable sharing with paired phones.'
                  )
                : t(
                    'commander.memorySignIn',
                    'Sign in to your Orca account on this desktop to open its memory.'
                  )}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}
