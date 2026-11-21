// Signing the bot's computer in to Orca from the phone: the computer starts an approve-in-browser
// sign-in, the phone opens its page, and the computer finishes once it is approved there. The
// desktop's startBotHostSignIn.
import { useCallback, useEffect, useRef, useState } from 'react'
import * as z from 'zod'
import { openExternalLink } from '../../platform/external-links/external-link'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const FlowSchema = z.looseObject({
  flowId: z.string(),
  revision: z.number(),
  phase: z.string(),
  prompt: z
    .looseObject({ kind: z.string().optional(), verificationUrl: z.string().optional() })
    .optional(),
  error: z.string().optional()
})

type Flow = z.infer<typeof FlowSchema>

function signInOperation<Method extends 'orcaAccount.signIn.start' | 'orcaAccount.signIn.wait'>(
  method: Method
) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant('orca-sign-in-flow', FlowSchema)
    })
  )
}

const signInStart = signInOperation('orcaAccount.signIn.start')
const signInWait = signInOperation('orcaAccount.signIn.wait')
const signInCancel = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orcaAccount.signIn.cancel',
    method: 'orcaAccount.signIn.cancel',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('orca-sign-in-cancelled', z.unknown())
  })
)

// The wait answers when the flow changes; past this the call ends and the wait asks again.
const WAIT_TIMEOUT_MS = 60_000
const RETRY_MS = 2_000

export type HostOrcaSignIn =
  | { phase: 'idle' }
  | { phase: 'waiting' }
  | { phase: 'failed'; error: string }

/** "Sign in to publish": the computer's own Orca sign-in, approved in the phone's browser. */
export function useHostOrcaSignIn(
  client: RpcClient | null,
  onSignedIn: () => void
): { view: HostOrcaSignIn; start: () => void; cancel: () => void } {
  const [view, setView] = useState<HostOrcaSignIn>({ phase: 'idle' })
  // The flow this screen follows; a cancel or unmount drops it.
  const flowRef = useRef<string | null>(null)
  const signedIn = useRef(onSignedIn)
  const clientRef = useRef(client)
  useEffect(() => {
    signedIn.current = onSignedIn
    clientRef.current = client
  })

  const follow = useCallback(async (host: RpcClient, from: Flow) => {
    let flow = from
    let opened = false
    while (flowRef.current === flow.flowId) {
      if (flow.phase === 'signedIn') {
        flowRef.current = null
        setView({ phase: 'idle' })
        signedIn.current()
        return
      }
      if (flow.phase === 'failed' || flow.phase === 'cancelled') {
        flowRef.current = null
        setView(
          flow.phase === 'failed' ? { phase: 'failed', error: flow.error ?? '' } : { phase: 'idle' }
        )
        return
      }
      const url = flow.prompt?.kind === 'approve-in-browser' ? flow.prompt.verificationUrl : null
      if (flow.phase === 'waiting' && flow.prompt && !url) {
        // An older computer wants a code pasted back, which only its own window can take.
        flowRef.current = null
        void signInCancel.request(host, { flowId: flow.flowId }).catch(() => undefined)
        setView({ phase: 'failed', error: '' })
        return
      }
      if (url && !opened) {
        opened = true
        openExternalLink(url)
      }
      const next = await signInWait
        .request(
          host,
          { flowId: flow.flowId, afterRevision: flow.revision },
          { timeoutMs: WAIT_TIMEOUT_MS }
        )
        .then((reply) => signInWait.interpret(reply))
        .catch(() => null)
      if (next) {
        flow = next
      } else {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      }
    }
  }, [])

  // Bumped by every start and cancel, so a start answered after a cancel is cancelled, not followed.
  const attempt = useRef(0)
  const cancel = useCallback(() => {
    attempt.current += 1
    const flowId = flowRef.current
    flowRef.current = null
    setView({ phase: 'idle' })
    if (flowId && clientRef.current) {
      void signInCancel.request(clientRef.current, { flowId }).catch(() => undefined)
    }
  }, [])

  useEffect(() => () => cancel(), [cancel])

  const start = useCallback(() => {
    if (!client) {
      return
    }
    const current = ++attempt.current
    setView({ phase: 'waiting' })
    signInStart
      .request(client, { approveInBrowser: true }, { failWhenDisconnected: true })
      .then((reply) => {
        const flow = signInStart.interpret(reply)
        if (current !== attempt.current) {
          void signInCancel.request(client, { flowId: flow.flowId }).catch(() => undefined)
          return
        }
        flowRef.current = flow.flowId
        return follow(client, flow)
      })
      .catch((cause: unknown) => {
        if (current !== attempt.current) {
          return
        }
        flowRef.current = null
        setView({ phase: 'failed', error: cause instanceof Error ? cause.message : '' })
      })
  }, [client, follow])

  return { view, start, cancel }
}
