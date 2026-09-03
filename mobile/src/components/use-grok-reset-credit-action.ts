import { useCallback, useRef, useState } from 'react'
import { Alert } from 'react-native'
import * as ExpoCrypto from 'expo-crypto'
import type { RpcClient } from '../transport/rpc-client'
import type { AccountsSnapshot } from './account-usage-state'
import { getGrokResetCreditOutcomeCopy, requestGrokResetCredit } from './grok-reset-credit'
import { useGrokResetCreditCapability } from './grok-reset-credit-capability'

export function useGrokResetCreditAction({
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
}): { supported: boolean; resetting: boolean; confirmReset: () => void } {
  const supported = useGrokResetCreditCapability(client, connected)
  const [resetting, setResetting] = useState(false)
  const inFlightRef = useRef(false)

  const consume = useCallback(async () => {
    if (!client || !hostId || inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    setResetting(true)
    try {
      const result = await requestGrokResetCredit(client, {
        hostId,
        createIdempotencyKey: () => ExpoCrypto.randomUUID()
      })
      onSnapshot(result.snapshot)
      const copy = getGrokResetCreditOutcomeCopy(result.outcome)
      Alert.alert(copy.title, copy.message)
    } catch (error) {
      Alert.alert(
        'Could not reset rate limits',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      inFlightRef.current = false
      setResetting(false)
    }
  }, [client, hostId, onSnapshot])

  const confirmReset = useCallback(() => {
    if (!supported || !connected || accountMutationBusy || resetting || !snapshot) {
      return
    }
    Alert.alert(
      'Use a rate-limit reset?',
      'This spends one SuperGrok usage-limit reset token for the signed-in host account and clears the current weekly pool immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Use reset', onPress: () => void consume() }
      ]
    )
  }, [accountMutationBusy, connected, consume, resetting, snapshot, supported])

  return { supported, resetting, confirmReset }
}
