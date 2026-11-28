// A chat's "isn't signed in" notice on a managed account: Sign in signs that account in again on the
// paired computer through the Accounts sheet. Chats on the agent's own login keep the terminal.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HostAccountSignInProvider } from '../../../../src/shared/agent-accounts/host-account-sign-in-types'
import { MOBILE_HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY } from '../../../../src/shared/remote-runtime/protocol/account-runtime-capabilities'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { AccountsSnapshotSchema } from '../accounts-snapshot'
import { MobileHostAccountSignInSheet } from './MobileHostAccountSignInSheet'
import { useHostAccountSignIn } from './use-host-account-sign-in'

const accountsList = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.list',
    method: 'accounts.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('accounts-snapshot', AccountsSnapshotSchema)
  })
)

/** The managed account the computer launches `provider` chats on now, as desktop's chat Sign in reads it. */
async function selectedManagedAccount(
  client: RpcClient,
  provider: HostAccountSignInProvider
): Promise<string | null> {
  const snapshot = accountsList.interpret(
    await accountsList.request(client, { refreshUsage: false })
  )
  const state = snapshot[provider]
  return state.activeAccountIdsByRuntime?.host ?? state.activeAccountId
}

/** A chat notice's Sign in, and the notice row whose Sign in last finished. */
export type ChatAccountSignIn = {
  signIn: (provider: HostAccountSignInProvider, rowId: string | undefined) => void
  signedInRow: string | null
}

export function useChatAccountSignIn(input: {
  client: RpcClient | null
  /** False when the chat runs on another server, whose accounts the phone can't reach. */
  onPairedHost: boolean
  hostName: string
  onSignedIn: (message: string) => void
  openAccounts: () => void
}): {
  /** Opens the paired host's Accounts; absent for a chat another server runs. */
  openAccounts: (() => void) | undefined
  accountSignIn: ChatAccountSignIn | undefined
  sheet: ReactNode
} {
  const { client, onSignedIn } = input
  const onOpenAccounts = input.onPairedHost ? input.openAccounts : undefined
  const t = useMobileTranslation()
  // The paired host's status the session already read; a chat another server runs never offers it.
  const supported =
    useOptionalHostProtocolGates()?.hostCapabilities.includes(
      MOBILE_HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY
    ) === true
  // The notice row whose own sign-in last finished (as desktop keeps one).
  const [signedInRow, setSignedInRow] = useState<string | null>(null)
  const signIn = useHostAccountSignIn(client, (account, target) => {
    if (target.askedBy !== undefined) {
      setSignedInRow(target.askedBy)
    }
    if (account) {
      onSignedIn(
        t('accounts.hostSignIn.signedInAs', 'Signed in as {{email}}', { email: account.email })
      )
    }
  })
  const { start } = signIn
  // Only the latest tap, on a still-open chat, acts on its lookup.
  const lookup = useRef(0)
  // A tap while the computer is still answering the last one asks nothing more.
  const looking = useRef(false)
  useEffect(() => {
    const current = lookup
    return () => {
      current.current += 1
    }
  }, [])
  const signInAccount = useCallback(
    (provider: HostAccountSignInProvider, rowId: string | undefined) => {
      if (!client || looking.current) {
        return
      }
      looking.current = true
      const asked = ++lookup.current
      void selectedManagedAccount(client, provider)
        .then(
          (accountId) => {
            if (asked === lookup.current) {
              return accountId ? start({ provider, accountId, askedBy: rowId }) : onOpenAccounts?.()
            }
          },
          () => {
            if (asked === lookup.current) {
              onOpenAccounts?.()
            }
          }
        )
        .finally(() => {
          looking.current = false
        })
    },
    [client, onOpenAccounts, start]
  )
  const offered = supported && input.onPairedHost
  // Why memoized: notice rows read it through context, and a chat re-renders on every streamed token.
  const accountSignIn = useMemo(
    () => (offered ? { signIn: signInAccount, signedInRow } : undefined),
    [offered, signInAccount, signedInRow]
  )
  return {
    openAccounts: onOpenAccounts,
    accountSignIn,
    sheet: (
      <MobileHostAccountSignInSheet
        target={signIn.target}
        open={signIn.open}
        view={signIn.view}
        hostName={input.hostName}
        onCancel={signIn.cancel}
        onRetry={signIn.start}
        submitCode={signIn.submitCode}
      />
    )
  }
}
