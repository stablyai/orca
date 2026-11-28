import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
  onToast: ((message: string, durationMs?: number) => void) | undefined
): { open: (() => void) | undefined; sheet: ReactNode } {
  // A copy, so a switch that frees the row (and drops `accounts`) leaves the sheet open.
  const [shown, setShown] = useState<AntigravityChatAccounts | null>(null)
  const close = useCallback(() => setShown(null), [])
  const open = useCallback(() => setShown(accounts ?? null), [accounts])
  // Why a ref: the session's toast callback may change identity every render.
  const toastRef = useRef(onToast)
  useLayoutEffect(() => {
    toastRef.current = onToast
  }, [onToast])
  // The switch message runs two lines, so it stays up long enough to read.
  const toast = useCallback((message: string) => toastRef.current?.(message, 4_000), [])
  return {
    open: accounts && onToast ? open : undefined,
    sheet: onToast ? (
      <MobileAntigravityChatAccountSheet accounts={shown} onClose={close} onToast={toast} />
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
      (next) => {
        if (!current) {
          return
        }
        // Removed elsewhere since the host offered the switch: nothing left to pick.
        if (next.accounts.length === 0) {
          onClose()
          return
        }
        setState(next)
      },
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
      visible={accounts !== null}
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
