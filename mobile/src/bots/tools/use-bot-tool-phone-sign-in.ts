// Signing a bot's tool in from the phone: its page opens in the phone's browser, which ends on the
// computer's 127.0.0.1 return address, and the address is pasted back. Orca's own sign-ins run on the
// bot's host for this phone (bots.tools.signIn.*); a tool its agent's CLI signs in to finishes there.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  botToolSignInFailureWords,
  botToolSignInPastedQuery,
  type BotToolSignInFailure
} from '../../../../src/shared/bot-tool-sign-in'
import { BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { openExternalLink } from '../../platform/external-links/external-link'
import { readConnectionStatusProbe } from '../../transport/connection/runtime-status-probe'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  botToolConnect,
  botToolFinishHeldSignIn,
  botToolSignInCancel,
  botToolSignInFinish,
  botToolSignInStart,
  botToolSignInStatusRead,
  botToolSignInWait,
  type PhoneOwnTool,
  type PhoneSignInAttempt
} from './bot-tool-operations'

type Waiting = Extract<PhoneSignInAttempt, { state: 'waiting' }>

// A dropped wait retries this often until the attempt expires; a CLI's sign-in is asked as often.
const RETRY_MS = 2_000
const HELD_WATCH_MS = 600_000

export type BotToolPhoneSignIn = {
  /** This phone's sign-in, while its page waits for the address pasted back. */
  attempt: { url: string | null; finishing: boolean } | null
  /** Why the last one ended without signing in. */
  failure: BotToolSignInFailure | 'needs-update' | undefined
  /** A refused paste or start, in words to show. */
  error: string | null
  starting: boolean
  start: () => void
  finish: (address: string) => void
  openAgain: () => void
  cancel: () => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function useBotToolPhoneSignIn(args: {
  client: RpcClient | null
  botId: string
  tool: Pick<PhoneOwnTool, 'name' | 'signIn'>
  hostName: string
  onSignedIn: () => void
}): BotToolPhoneSignIn {
  const t = useMobileTranslation()
  const { client, botId, hostName } = args
  const name = args.tool.name
  const owned = args.tool.signIn !== undefined
  const onSignedIn = useRef(args.onSignedIn)
  useEffect(() => {
    onSignedIn.current = args.onSignedIn
  })
  // Each start or cancel bumps it, so an older attempt's answers are dropped.
  const generation = useRef(0)
  const waiting = useRef<Waiting | null>(null)
  const [attempt, setAttempt] = useState<BotToolPhoneSignIn['attempt']>(null)
  const [failure, setFailure] = useState<BotToolPhoneSignIn['failure']>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const leave = useCallback(() => {
    generation.current += 1
    const flow = waiting.current
    waiting.current = null
    if (flow && client) {
      void botToolSignInCancel.request(client, { flowId: flow.flowId }).catch(() => {})
    }
  }, [client])
  const cancel = useCallback(() => {
    leave()
    setAttempt(null)
    setStarting(false)
    setError(null)
  }, [leave])
  // Nobody can paste into a closed page (or one hidden, or on a replaced client), so the host's
  // attempt ends with it, as on the desktop, and the page shows Sign in again.
  useEffect(() => cancel, [cancel])

  const settle = useCallback(
    (gen: number, view: PhoneSignInAttempt | { state: 'done' }) => {
      if (gen !== generation.current) {
        return
      }
      if (view.state === 'done' || view.state === 'failed') {
        // Ended: a later answer about this attempt (finish's and wait's both say done) changes nothing.
        generation.current += 1
        waiting.current = null
        setAttempt(null)
        setStarting(false)
      }
      if (view.state === 'done') {
        setError(null)
        onSignedIn.current()
      } else if (view.state === 'failed') {
        setFailure(view.code)
        setError(botToolSignInFailureWords(view.code, hostName))
      } else if (view.state === 'finishing') {
        setAttempt((shown) => (shown ? { ...shown, finishing: true } : shown))
      } else if (view.state === 'waiting') {
        const shown = waiting.current
        if (shown?.flowId === view.flowId && shown.revision === view.revision) {
          // A wait that timed out with nothing new; a Finish under way stays under way.
          return
        }
        waiting.current = view
        setAttempt({ url: view.authorizationUrl, finishing: false })
      }
    },
    [hostName]
  )

  const follow = useCallback(
    async (gen: number, first: Waiting) => {
      if (!client) {
        return
      }
      let revision = first.revision
      while (gen === generation.current) {
        const next = await botToolSignInWait
          .request(client, { flowId: first.flowId, afterRevision: revision }, { timeoutMs: 60_000 })
          .then((response) => botToolSignInWait.interpret(response))
          .catch(() => null)
        if (gen !== generation.current) {
          return
        }
        if (!next) {
          if (Date.now() > first.expiresAt) {
            settle(gen, { ...first, state: 'failed', code: 'expired' })
            return
          }
          await sleep(RETRY_MS)
          continue
        }
        revision = next.revision
        settle(gen, next)
        if (next.state === 'done' || next.state === 'failed') {
          return
        }
      }
    },
    [client, settle]
  )

  const start = useCallback(() => {
    if (!client) {
      return
    }
    leave()
    const gen = generation.current
    setFailure(undefined)
    setError(null)
    if (owned) {
      const capabilities = readConnectionStatusProbe(client)?.capabilities
      if (capabilities && !capabilities.includes(BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY)) {
        setFailure('needs-update')
        return
      }
    }
    setStarting(true)
    const begin = owned
      ? botToolSignInStart.request(client, { botId, name, mode: 'paste' }).then((response) => {
          const view = botToolSignInStart.interpret(response)
          if (gen !== generation.current) {
            // Left before the host answered: end what it started.
            void botToolSignInCancel.request(client, { flowId: view.flowId }).catch(() => {})
            return
          }
          settle(gen, view)
          if (view.state === 'waiting') {
            openExternalLink(view.authorizationUrl)
            void follow(gen, view)
          }
        })
      : botToolConnect.request(client, { botId, name }).then((response) => {
          const { authorizationUrl } = botToolConnect.interpret(response)
          if (gen !== generation.current) {
            return
          }
          if (!authorizationUrl) {
            // Its CLI opened the page on the computer; only that browser can finish it.
            setError(botToolSignInFailureWords('desktop-only', hostName))
            return
          }
          setAttempt({ url: authorizationUrl, finishing: false })
          // The CLI names this page; only a web page may open, as the desktop's shell allows.
          if (/^https?:\/\//i.test(authorizationUrl)) {
            openExternalLink(authorizationUrl)
          }
        })
    void begin
      .catch((caught: unknown) => gen === generation.current && setError(messageOf(caught)))
      .finally(() => gen === generation.current && setStarting(false))
  }, [client, botId, name, owned, hostName, leave, settle, follow])

  const watchHeld = useCallback(
    async (gen: number) => {
      if (!client) {
        return
      }
      const deadline = Date.now() + HELD_WATCH_MS
      while (gen === generation.current && Date.now() < deadline) {
        const status = await botToolSignInStatusRead
          .request(client, { botId, name })
          .then((response) => botToolSignInStatusRead.interpret(response).status)
          .catch(() => 'pending')
        if (status === 'done') {
          settle(gen, { state: 'done' })
          return
        }
        if (status !== 'pending') {
          settle(gen, { flowId: '', revision: 0, expiresAt: 0, state: 'failed', code: 'refused' })
          return
        }
        await sleep(RETRY_MS)
      }
      settle(gen, { flowId: '', revision: 0, expiresAt: 0, state: 'failed', code: 'expired' })
    },
    [client, botId, name, settle]
  )

  const finish = useCallback(
    (address: string) => {
      if (!client || !attempt || attempt.finishing) {
        return
      }
      const gen = generation.current
      setError(null)
      const flow = waiting.current
      if (!owned) {
        setAttempt({ ...attempt, finishing: true })
        void botToolFinishHeldSignIn
          .request(client, { botId, name, address })
          .then((response) => {
            botToolFinishHeldSignIn.interpret(response)
            void watchHeld(gen)
          })
          .catch((caught: unknown) => {
            if (gen === generation.current) {
              setAttempt({ ...attempt, finishing: false })
              setError(messageOf(caught))
            }
          })
        return
      }
      if (!flow) {
        return
      }
      const query = botToolSignInPastedQuery(address, flow)
      if (query === null) {
        setError(
          t(
            'bots.tools.signIn.notThisSignIn',
            'That address isn’t from this sign-in. Paste the address you landed on.'
          )
        )
        return
      }
      setAttempt({ ...attempt, finishing: true })
      void botToolSignInFinish
        .request(client, { flowId: flow.flowId, query })
        .then((response) => settle(gen, botToolSignInFinish.interpret(response)))
        .catch((caught: unknown) => {
          // A refused paste spends nothing: the page waits for the right address.
          if (gen === generation.current) {
            setAttempt({ ...attempt, finishing: false })
            setError(messageOf(caught))
          }
        })
    },
    [client, attempt, owned, botId, name, t, settle, watchHeld]
  )

  const openAgain = useCallback(() => {
    if (attempt?.url) {
      openExternalLink(attempt.url)
    }
  }, [attempt])

  return { attempt, failure, error, starting, start, finish, openAgain, cancel }
}
