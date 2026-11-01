import { useCallback, useMemo, useRef, useState } from 'react'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'
import type { RpcClient } from '../transport/rpc-client'
import { translate } from '../i18n/mobile-i18n'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { AccountsSnapshot } from './account-usage-state'
import {
  getCodexResetCreditOutcomeCopy,
  getCodexResetCreditScope,
  requestCodexResetCredit
} from './codex-reset-credit'
import { useCodexResetCreditCapability } from './codex-reset-credit-capability'

type CodexResetDialog = { title: string; message: string }

function describeScope(
  snapshot: AccountsSnapshot,
  scope: CodexResetCreditExpectedScope,
  t: Translate
): { label: string; message: string } {
  const account = snapshot.codex.accounts.find((candidate) => candidate.id === scope.accountId)
  const identity = account?.email
  if (scope.target.runtime === 'host') {
    return identity != null
      ? {
          label: t('components.useCodexResetCreditAction.hostAccount', '{{identity}} on the host', {
            identity
          }),
          message: t(
            'components.useCodexResetCreditAction.hostAccountConfirmMessage',
            'This spends one earned reset for {{identity}} on the host and immediately resets eligible rate-limit windows.',
            { identity }
          )
        }
      : {
          label: t(
            'components.useCodexResetCreditAction.hostSelectedAccount',
            'the selected managed account on the host'
          ),
          message: t(
            'components.useCodexResetCreditAction.hostSelectedAccountConfirmMessage',
            'This spends one earned reset for the selected managed account on the host and immediately resets eligible rate-limit windows.'
          )
        }
  }
  const options = { identity, distro: scope.target.wslDistro }
  return identity != null
    ? {
        label: t(
          'components.useCodexResetCreditAction.wslAccount',
          '{{identity}} on WSL {{distro}}',
          options
        ),
        message: t(
          'components.useCodexResetCreditAction.wslAccountConfirmMessage',
          'This spends one earned reset for {{identity}} on WSL {{distro}} and immediately resets eligible rate-limit windows.',
          options
        )
      }
    : {
        label: t(
          'components.useCodexResetCreditAction.wslSelectedAccount',
          'the selected managed account on WSL {{distro}}',
          options
        ),
        message: t(
          'components.useCodexResetCreditAction.wslSelectedAccountConfirmMessage',
          'This spends one earned reset for the selected managed account on WSL {{distro}} and immediately resets eligible rate-limit windows.',
          options
        )
      }
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
  const t = useMobileTranslation()
  const supported = useCodexResetCreditCapability(client, connected)
  const [resetting, setResetting] = useState(false)
  const [confirming, setConfirming] = useState<{
    scope: CodexResetCreditExpectedScope
    snapshot: AccountsSnapshot
  } | null>(null)
  const inFlightRef = useRef(false)
  const resetScope = useMemo(
    () => (snapshot ? getCodexResetCreditScope(snapshot) : null),
    [snapshot]
  )
  const scopeLabel = useMemo(
    () => (snapshot && resetScope ? describeScope(snapshot, resetScope, t).label : null),
    [resetScope, snapshot, t]
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
            title: translate(
              'components.useCodexResetCreditAction.detailsChanged',
              'Reset details changed'
            ),
            message: translate(
              'components.useCodexResetCreditAction.detailsChangedMessage',
              'The account or reset offer changed before the host contacted Codex. Review the updated details, then confirm again.'
            )
          })
          return
        }
        onNotice(getCodexResetCreditOutcomeCopy(result.outcome))
      } catch (error) {
        onNotice({
          title: translate(
            'components.useCodexResetCreditAction.resetFailed',
            'Could not reset rate limits'
          ),
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
    setConfirming({ scope: resetScope, snapshot })
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
        title: t('components.useCodexResetCreditAction.confirmTitle', 'Use a rate-limit reset?'),
        message: describeScope(confirming.snapshot, confirming.scope, t).message
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
