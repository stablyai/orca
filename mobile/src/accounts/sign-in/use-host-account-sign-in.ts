// One Claude/Codex sign-in the phone runs on its paired computer: the computer's login prints a page
// the phone opens, and a pasted code (Claude) or the page itself (Codex) finishes it there. The
// desktop's runtime-host-account-sign-in-client, on the same shared run, which keeps asking while the
// phone is away on that page.
import { useCallback, useEffect, useRef, useState } from 'react'
import { HostAccountSignInRun } from '../../../../src/shared/agent-accounts/host-account-sign-in-run'
import type { HostAccountSignInProvider } from '../../../../src/shared/agent-accounts/host-account-sign-in-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  HOST_ACCOUNT_SIGN_IN_CANCELLED,
  phoneHostAccountSignInTransport,
  type PhoneHostAccountSignInStatus
} from './host-account-sign-in-operations'

export type HostAccountSignInTarget = {
  provider: HostAccountSignInProvider
  /** The saved account to sign in again; absent adds one. */
  accountId?: string
  /** The accounts already saved, so the one an Add made can be named. */
  knownAccountIds?: readonly string[]
  /** What asked for it (a chat notice row), handed back with its outcome. */
  askedBy?: string
}

export type HostAccountSignInView =
  | { kind: 'running'; status: PhoneHostAccountSignInStatus | null }
  | { kind: 'failed'; error: string }

export type SignedInAccount = { email: string; displayName?: string }

type Run = HostAccountSignInRun<PhoneHostAccountSignInStatus>

/** The account the finished sign-in saved: the one asked for, else the one an Add made. */
function signedInAccount(
  target: HostAccountSignInTarget,
  status: PhoneHostAccountSignInStatus
): SignedInAccount | null {
  const accounts = status[target.provider]?.accounts ?? []
  const known = new Set(target.knownAccountIds ?? [])
  return (
    accounts.find((account) =>
      target.accountId ? account.id === target.accountId : !known.has(account.id)
    ) ?? null
  )
}

export function useHostAccountSignIn(
  client: RpcClient | null,
  onSignedIn: (account: SignedInAccount | null, target: HostAccountSignInTarget) => void
) {
  // The last sign-in asked for, kept while the sheet slides away.
  const [target, setTarget] = useState<HostAccountSignInTarget | null>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<HostAccountSignInView>({ kind: 'running', status: null })
  // The run the sheet shows; a failed one stays here so closing the sheet still cancels it on the host.
  const runRef = useRef<Run | null>(null)
  // A lookup that answers after the screen closed must not start a sign-in nothing can cancel.
  const mounted = useRef(false)
  const signedIn = useRef(onSignedIn)
  useEffect(() => {
    signedIn.current = onSignedIn
  })

  const start = useCallback(
    (next: HostAccountSignInTarget) => {
      if (!client || !mounted.current) {
        return
      }
      const previous = runRef.current
      // Try again joins the same flow on the host; a different sign-in replaces the one before it.
      if (
        previous &&
        (previous.provider !== next.provider || previous.accountId !== next.accountId)
      ) {
        void previous.cancel().catch(() => undefined)
      }
      const run: Run = new HostAccountSignInRun(
        next.provider,
        next.accountId,
        phoneHostAccountSignInTransport(client, next.provider),
        () => {
          if (runRef.current === run) {
            setView({ kind: 'running', status: run.status })
          }
        }
      )
      runRef.current = run
      setTarget(next)
      setOpen(true)
      setView({ kind: 'running', status: null })
      run.run().then(
        (status) => {
          // A sign-in the host finished after Cancel still saved the account, so it is still named.
          if (runRef.current === run) {
            runRef.current = null
            setOpen(false)
          }
          signedIn.current(signedInAccount(next, status), next)
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (runRef.current === run && message !== HOST_ACCOUNT_SIGN_IN_CANCELLED[next.provider]) {
            setView({ kind: 'failed', error: message })
          }
        }
      )
    },
    [client]
  )

  /** Stops the sign-in on the computer and closes the sheet; the computer settles it on its own. */
  const cancel = useCallback(() => {
    const run = runRef.current
    runRef.current = null
    setOpen(false)
    void run?.cancel().catch(() => undefined)
  }, [])

  const submitCode = useCallback(async (code: string): Promise<void> => {
    const run = runRef.current
    if (!run) {
      return
    }
    await run.submitCode(code)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancel()
    }
  }, [cancel])

  return { target, open, view, start, cancel, submitCode }
}
