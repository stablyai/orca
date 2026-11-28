// Accounts' Add account and Sign in: the computer's login, relayed through the sign-in sheet.
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { Plus, User } from 'lucide-react-native'
import { getCodexAccountAuthWarning } from '../../../../src/shared/agent-accounts/codex/codex-account-auth-warning'
import { MOBILE_HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY } from '../../../../src/shared/remote-runtime/protocol/account-runtime-capabilities'
import { TransientToast, useTransientToast } from '../../components/feedback/TransientToast'
import { ListRow } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import type { MobilePalette } from '../../theme/mobile-theme'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../theme/themed-styles'
import { stylesSheet } from '../mobile-accounts-screen-styles'
import { useRuntimeCapability } from '../../transport/connection/use-runtime-capability'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { AccountsSnapshot } from '../accounts-snapshot'
import type { ProviderKey } from '../usage/usage-selectors'
import { MobileHostAccountSignInSheet } from './MobileHostAccountSignInSheet'
import { useHostAccountSignIn, type HostAccountSignInTarget } from './use-host-account-sign-in'

export function useAccountsScreenSignIn(input: {
  client: RpcClient | null
  connected: boolean
  hostName: string
  bottomInset: number
  /** The accounts on screen are current, so a row may act on them. */
  live: boolean
  onSignedIn: () => void
}): {
  /** The computer can add and sign accounts in from here. */
  supported: boolean
  start: (target: HostAccountSignInTarget) => void
  /** How one saved account reads: signed out in red, with Sign in where the computer can. */
  rowFor: (
    provider: ProviderKey,
    account: Parameters<typeof accountSignedOut>[1],
    activeAccountId: string | null,
    snapshot: AccountsSnapshot
  ) => ReturnType<typeof signedOutRowProps>
  /** The provider group's Add account row, where the computer can add one from here. */
  addRow: (provider: ProviderKey, accounts: readonly { id: string }[]) => ReactNode
  /** The sheet and its toast, for the end of the screen. */
  overlay: ReactNode
} {
  const t = useMobileTranslation()
  const supported = useRuntimeCapability(
    input.client,
    input.connected,
    MOBILE_HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY
  )
  const toast = useTransientToast()
  const signIn = useHostAccountSignIn(input.client, (account) => {
    input.onSignedIn()
    if (account) {
      toast.showToast(
        t('accounts.hostSignIn.signedInAs', 'Signed in as {{email}}', { email: account.email })
      )
    }
  })
  const colors = useMobileColors()
  const canSignIn = supported && input.live
  return {
    supported,
    start: signIn.start,
    rowFor: (provider, account, activeAccountId, snapshot) =>
      signedOutRowProps(
        accountSignedOut(provider, account, activeAccountId, snapshot),
        canSignIn,
        colors,
        t
      ),
    addRow: (provider, accounts) =>
      canSignIn ? (
        <AddAccountRow key="add" provider={provider} accounts={accounts} start={signIn.start} />
      ) : null,
    overlay: (
      <>
        <MobileHostAccountSignInSheet
          target={signIn.target}
          open={signIn.open}
          view={signIn.view}
          hostName={input.hostName}
          onCancel={signIn.cancel}
          onRetry={signIn.start}
          submitCode={signIn.submitCode}
        />
        <TransientToast message={toast.message} bottomInset={input.bottomInset} />
      </>
    )
  }
}

/** The blue row that ends a provider's group, as Home's "Pair a computer" ends its list. */
function AddAccountRow(props: {
  provider: ProviderKey
  accounts: readonly { id: string }[]
  start: (target: HostAccountSignInTarget) => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  return (
    <ListRow
      leading={<Plus size={18} color={colors.accentBlue} strokeWidth={2.2} />}
      title={t('accounts.screen.addAccount', 'Add account')}
      accent
      onPress={() =>
        props.start({
          provider: props.provider,
          knownAccountIds: props.accounts.map((account) => account.id)
        })
      }
    />
  )
}

/** A signed-out account in red, with Sign in where the computer can do it from here. */
function signedOutRowProps(
  signedOut: boolean,
  canSignIn: boolean,
  colors: MobilePalette,
  t: Translate
) {
  const offerSignIn = signedOut && canSignIn
  return {
    signedOut,
    offerSignIn,
    note: signedOut ? t('accounts.screen.signedOut', 'Signed out') : null,
    /** A screen reader hears the action, not only the account, when the row signs it in. */
    label: (account: string) =>
      offerSignIn ? `${account}, ${t('accounts.screen.signIn', 'Sign in')}` : account,
    props: {
      accessibilityRole: offerSignIn ? ('button' as const) : undefined,
      subtitleColor: signedOut ? colors.statusRed : undefined,
      value: offerSignIn ? t('accounts.screen.signIn', 'Sign in') : undefined,
      valueColor: offerSignIn ? colors.accentBlue : undefined
    }
  }
}

/** A computer that can't sign accounts in from here: the desktop does it. */
export function ManageOnDesktopHint() {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.footerHint}>
      <User size={14} color={colors.textMuted} />
      <Text style={styles.footerHintText}>
        {t(
          'accounts.screen.manageAccountsHint',
          'Add or re-authenticate accounts from desktop Settings → Accounts.'
        )}
      </Text>
    </View>
  )
}

/** Claude's saved folder holds no login, or Codex reported its sign-in out of date. */
function accountSignedOut(
  provider: ProviderKey,
  account: {
    id: string
    needsSignIn?: true
    managedHomeRuntime?: 'host' | 'wsl'
    wslDistro?: string | null
  },
  activeAccountId: string | null,
  snapshot: AccountsSnapshot
): boolean {
  if (provider === 'claude') {
    return account.needsSignIn === true
  }
  const limits = snapshot.rateLimits.codex
  return (
    getCodexAccountAuthWarning({
      limits: limits ? { status: limits.status, error: limits.error } : null,
      target: snapshot.rateLimits.codexTarget,
      runtime: { runtime: account.managedHomeRuntime ?? 'host', wslDistro: account.wslDistro },
      activeAccountId,
      accountId: account.id
    }) !== null
  )
}
