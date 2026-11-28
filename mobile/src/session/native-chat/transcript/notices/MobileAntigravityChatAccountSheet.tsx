import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { PickerListDrawer } from '../../../../components/sheets/PickerListDrawer'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import {
  antigravityChatAccountId,
  antigravitySwitchedMessage,
  antigravitySwitchFailedTitle,
  type AntigravityChatAccounts
} from '../../../../accounts/antigravity-account-switch'
import type { AntigravityAccountState } from '../../../../accounts/provider-account-operations'

/** The chat's Antigravity account sheet and the row's way to open it; null `open` offers none. */
export function useMobileAntigravityChatAccountSheet(
  accounts: AntigravityChatAccounts | null | undefined,
  onToast: ((message: string) => void) | undefined
): { open: (() => void) | undefined; sheet: ReactNode } {
  // A copy, so a switch that frees the row (and drops `accounts`) leaves the sheet open.
  const [shown, setShown] = useState<AntigravityChatAccounts | null>(null)
  const close = useCallback(() => setShown(null), [])
  const open = useCallback(() => setShown(accounts ?? null), [accounts])
  return {
    open: accounts && onToast ? open : undefined,
    sheet: onToast ? (
      <MobileAntigravityChatAccountSheet accounts={shown} onClose={close} onToast={onToast} />
    ) : null
  }
}

/** A usage-limited Antigravity chat's "Switch Account": its host's saved accounts; a pick moves the
 *  chat at its next message. Owned by the chat, so a switch that frees the row still finishes. */
export function MobileAntigravityChatAccountSheet({
  accounts,
  onClose,
  onToast
}: {
  accounts: AntigravityChatAccounts | null
  onClose: () => void
  onToast: (message: string) => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const [state, setState] = useState<AntigravityAccountState | null>(null)
  useEffect(() => {
    if (!accounts) {
      return
    }
    let current = true
    // Another surface may have switched or saved an account since this chat last looked.
    accounts.list().then(
      (next) => current && setState(next),
      (error: unknown) => {
        if (current) {
          onToast(failureText(t, error))
          onClose()
        }
      }
    )
    return () => {
      current = false
      setState(null)
    }
  }, [accounts, onClose, onToast, t])
  const selectedId = state ? (antigravityChatAccountId(state) ?? '') : ''
  const select = (accountId: string): void => {
    if (!accounts || accountId === selectedId) {
      return
    }
    accounts.select(accountId).then(
      (next) =>
        onToast(
          next
            ? antigravitySwitchedMessage(t, next, accountId)
            : t(
                'chat.usageLimit.accountUnavailable',
                'This chat cannot move to another account. Hand it off to another agent instead.'
              )
        ),
      (error: unknown) => onToast(failureText(t, error))
    )
  }
  return (
    <PickerListDrawer
      visible={accounts !== null && state !== null}
      title={t('chat.usageLimit.accounts', 'Accounts')}
      items={(state?.accounts ?? []).map((account) => ({
        id: account.id,
        label: account.email ?? t('accounts.screen.antigravitySaved', 'Saved Google account')
      }))}
      selectedId={selectedId}
      onSelect={(item) => select(item.id)}
      onClose={onClose}
    />
  )
}

function failureText(t: ReturnType<typeof useMobileTranslation>, error: unknown): string {
  const title = antigravitySwitchFailedTitle(t)
  return error instanceof Error && error.message ? `${title} ${error.message}` : title
}
