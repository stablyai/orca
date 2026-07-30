import { useCallback, useMemo, useRef, useState } from 'react'
import { Alert } from 'react-native'
import * as ExpoCrypto from 'expo-crypto'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'
import type { RpcClient } from '../transport/rpc-client'
import type { AccountsSnapshot } from './account-usage-state'
import {
  getCodexResetCreditOutcomeCopy,
  getCodexResetCreditScope,
  requestCodexResetCredit
} from './codex-reset-credit'
import { useCodexResetCreditCapability } from './codex-reset-credit-capability'
import { t } from '@/i18n/mobile-i18n'

function describeScope(snapshot: AccountsSnapshot, scope: CodexResetCreditExpectedScope): string {
  const account = snapshot.codex.accounts.find((candidate) => candidate.id === scope.accountId)
  const identity = account?.email ?? 'the selected managed account'
  if (scope.target.runtime === 'host') {
    return t('m.TUCQXxI', { value0: identity })
  }
  return t('m.sDDLSuM', { value0: identity, value1: scope.target.wslDistro })
}

export function useCodexResetCreditAction({
  client,
  connected,
  hostId,
  snapshot,
  accountMutationBusy,
  onSnapshot
}: {
  client: RpcClient | null
  connected: boolean
  hostId: string | undefined
  snapshot: AccountsSnapshot | null
  accountMutationBusy: boolean
  onSnapshot: (snapshot: AccountsSnapshot) => void
}): {
  supported: boolean
  resetting: boolean
  resetScope: CodexResetCreditExpectedScope | null
  scopeLabel: string | null
  confirmReset: () => void
} {
  const supported = useCodexResetCreditCapability(client, connected)
  const [resetting, setResetting] = useState(false)
  const inFlightRef = useRef(false)
  const resetScope = useMemo(
    () => (snapshot ? getCodexResetCreditScope(snapshot) : null),
    [snapshot]
  )
  const scopeLabel = useMemo(
    () => (snapshot && resetScope ? describeScope(snapshot, resetScope) : null),
    [resetScope, snapshot]
  )

  const consume = useCallback(
    async (expectedScope: CodexResetCreditExpectedScope) => {
      if (!client || !hostId || inFlightRef.current) {
        return
      }
      inFlightRef.current = true
      setResetting(true)
      try {
        const result = await requestCodexResetCredit(client, {
          hostId,
          expectedScope,
          createIdempotencyKey: () => ExpoCrypto.randomUUID()
        })
        onSnapshot(result.snapshot)
        if ('status' in result) {
          const cleanupWarning = result.attemptJournalRetained ? t('m.d5V00qM') : ''
          Alert.alert(t('m.4DQGAog'), t('m.rii7ZAs', { value0: cleanupWarning }))
          return
        }
        const copy = getCodexResetCreditOutcomeCopy(result.outcome)
        const cleanupWarning = result.attemptJournalRetained ? t('m.rXScUPU') : ''
        Alert.alert(copy.title, `${copy.message}${cleanupWarning}`)
      } catch (error) {
        Alert.alert(t('m.TKIeXbw'), error instanceof Error ? error.message : String(error))
      } finally {
        inFlightRef.current = false
        setResetting(false)
      }
    },
    [client, hostId, onSnapshot]
  )

  const confirmReset = useCallback(() => {
    if (!supported || !connected || accountMutationBusy || resetting || !resetScope || !snapshot) {
      return
    }
    const confirmedScope = resetScope
    const confirmedLabel = describeScope(snapshot, confirmedScope)
    Alert.alert(t('m.EzPa9ek'), t('m.5hDxS58', { value0: confirmedLabel }), [
      { text: t('m._nuDzHY'), style: 'cancel' },
      { text: t('m.VWnR13E'), onPress: () => void consume(confirmedScope) }
    ])
  }, [accountMutationBusy, connected, consume, resetScope, resetting, snapshot, supported])

  return { supported, resetting, resetScope, scopeLabel, confirmReset }
}
