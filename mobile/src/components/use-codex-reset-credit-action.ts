import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from 'react-native'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'
import type { HostAccountsOperations } from '../accounts/host-accounts-operations'
import type { AccountsSnapshot } from './account-usage-state'
import { getCodexResetCreditOutcomeCopy, getCodexResetCreditScope } from './codex-reset-credit'

function describeScope(snapshot: AccountsSnapshot, scope: CodexResetCreditExpectedScope): string {
  const account = snapshot.codex.accounts.find((candidate) => candidate.id === scope.accountId)
  const identity = account?.email ?? 'the selected managed account'
  if (scope.target.runtime === 'host') {
    return `${identity} on the host`
  }
  return `${identity} on WSL ${scope.target.wslDistro}`
}

export function useCodexResetCreditAction({
  operations,
  connected,
  snapshot,
  accountMutationBusy,
  onSnapshot
}: {
  operations: HostAccountsOperations | null
  connected: boolean
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
  const [supported, setSupported] = useState(false)
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

  useEffect(() => {
    let stale = false
    setSupported(false)
    if (!operations || !connected) {
      return
    }
    void operations
      .readCodexResetCreditCapability()
      .then((nextSupported) => {
        if (!stale) {
          setSupported(nextSupported)
        }
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [connected, operations])

  const consume = useCallback(
    async (expectedScope: CodexResetCreditExpectedScope) => {
      if (!operations || inFlightRef.current) {
        return
      }
      inFlightRef.current = true
      setResetting(true)
      try {
        const result = await operations.consumeCodexResetCredit(expectedScope)
        onSnapshot(result.snapshot)
        if ('status' in result) {
          const cleanupWarning = result.attemptJournalRetained
            ? '\n\nThis phone could not clear the discarded retry record. Retrying it is safe, but the record must be cleared before a new reset can be confirmed for this account.'
            : ''
          Alert.alert(
            'Reset details changed',
            `The account or reset offer changed before the host contacted Codex. Review the updated details, then confirm again.${cleanupWarning}`
          )
          return
        }
        const copy = getCodexResetCreditOutcomeCopy(result.outcome)
        const cleanupWarning = result.attemptJournalRetained
          ? '\n\nThe host confirmed this attempt, but this phone could not clear its retry record. A later retry will reuse the same safe operation ID.'
          : ''
        Alert.alert(copy.title, `${copy.message}${cleanupWarning}`)
      } catch (error) {
        Alert.alert(
          'Could not reset rate limits',
          error instanceof Error ? error.message : String(error)
        )
      } finally {
        inFlightRef.current = false
        setResetting(false)
      }
    },
    [onSnapshot, operations]
  )

  const confirmReset = useCallback(() => {
    if (!supported || !connected || accountMutationBusy || resetting || !resetScope || !snapshot) {
      return
    }
    const confirmedScope = resetScope
    const confirmedLabel = describeScope(snapshot, confirmedScope)
    Alert.alert(
      'Use a rate-limit reset?',
      `This spends one earned reset for ${confirmedLabel} and immediately resets eligible rate-limit windows.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Use reset', onPress: () => void consume(confirmedScope) }
      ]
    )
  }, [accountMutationBusy, connected, consume, resetScope, resetting, snapshot, supported])

  return { supported, resetting, resetScope, scopeLabel, confirmReset }
}
