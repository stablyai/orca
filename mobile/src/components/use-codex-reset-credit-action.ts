import { useCallback, useMemo, useRef, useState } from 'react'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'
import type { RpcClient } from '../transport/rpc-client'
import type { AccountsSnapshot } from './account-usage-state'
import {
  getCodexResetCreditOutcomeCopy,
  getCodexResetCreditScope,
  requestCodexResetCredit
} from './codex-reset-credit'
import { useCodexResetCreditCapability } from './codex-reset-credit-capability'

type CodexResetDialog = { title: string; message: string }

function describeScope(snapshot: AccountsSnapshot, scope: CodexResetCreditExpectedScope): string {
  const account = snapshot.codex.accounts.find((candidate) => candidate.id === scope.accountId)
  const identity = account?.email ?? 'the selected managed account'
  if (scope.target.runtime === 'host') {
    return `${identity} on the host`
  }
  return `${identity} on WSL ${scope.target.wslDistro}`
}

export function useCodexResetCreditAction({
  client,
  connected,
  snapshot,
  accountMutationBusy,
  onSnapshot,
  onNotice
}: {
  client: RpcClient | null
  connected: boolean
  snapshot: AccountsSnapshot | null
  accountMutationBusy: boolean
  onSnapshot: (snapshot: AccountsSnapshot) => void
  onNotice: (notice: CodexResetDialog) => void
}): {
  supported: boolean
  resetting: boolean
  resetScope: CodexResetCreditExpectedScope | null
  scopeLabel: string | null
  confirmReset: () => void
  /** The pending confirmation prompt, or null when none is open. */
  confirmation: CodexResetDialog | null
  acceptReset: () => void
  cancelReset: () => void
} {
  const supported = useCodexResetCreditCapability(client, connected)
  const [resetting, setResetting] = useState(false)
  const [confirming, setConfirming] = useState<{
    scope: CodexResetCreditExpectedScope
    label: string
  } | null>(null)
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
      if (!client || inFlightRef.current) {
        return
      }
      inFlightRef.current = true
      setResetting(true)
      try {
        const result = await requestCodexResetCredit(client, expectedScope)
        onSnapshot(result.snapshot)
        if ('status' in result) {
          onNotice({
            title: 'Reset details changed',
            message:
              'The account or reset offer changed before the host contacted Codex. Review the updated details, then confirm again.'
          })
          return
        }
        onNotice(getCodexResetCreditOutcomeCopy(result.outcome))
      } catch (error) {
        onNotice({
          title: 'Could not reset rate limits',
          message: error instanceof Error ? error.message : String(error)
        })
      } finally {
        inFlightRef.current = false
        setResetting(false)
      }
    },
    [client, onNotice, onSnapshot]
  )

  const confirmReset = useCallback(() => {
    if (!supported || !connected || accountMutationBusy || resetting || !resetScope || !snapshot) {
      return
    }
    // The scope is pinned when the prompt opens, so a snapshot arriving under it changes nothing.
    setConfirming({ scope: resetScope, label: describeScope(snapshot, resetScope) })
  }, [accountMutationBusy, connected, resetScope, resetting, snapshot, supported])

  const acceptReset = useCallback(() => {
    if (confirming) {
      setConfirming(null)
      void consume(confirming.scope)
    }
  }, [confirming, consume])
  const cancelReset = useCallback(() => setConfirming(null), [])
  const confirmation = confirming
    ? {
        title: 'Use a rate-limit reset?',
        message: `This spends one earned reset for ${confirming.label} and immediately resets eligible rate-limit windows.`
      }
    : null

  return {
    supported,
    resetting,
    resetScope,
    scopeLabel,
    confirmReset,
    confirmation,
    acceptReset,
    cancelReset
  }
}
