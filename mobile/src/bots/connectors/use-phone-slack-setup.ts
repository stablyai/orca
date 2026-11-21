// One run of Connect Slack on the phone, the desktop's use-bot-slack-setup for a paired computer's bot: its
// steps from the cloud's state, the token form, and Slack's install page in the phone's browser. Slack returns
// to Orca Cloud, not the computer, so the phone finishes it and watches the bot's state for the install.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { ConnectorBotSlackAppResponse } from '../../../../src/shared/connector-bot-slack-contract'
import type { Translate } from '../../i18n/mobile-i18n'
import { openExternalLink } from '../../platform/external-links/external-link'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { slackCall, slackSaveGrant, slackSetUpApp } from './bot-slack-operations'
import { slackErrorMessage } from './mobile-slack-copy'
import { slackTeamState } from '../../../../src/shared/connector-bot-slack-contract'
import type { PhoneSlackView } from './use-phone-bot-slack'

type InstallLink = { authorizeUrl: string; expiresAt: number | null }

export type PhoneSlackSetupStep =
  | { kind: 'checking' }
  /** `teamId`: the workspace whose token lapsed. */
  | { kind: 'token'; reconnect: boolean; error: string | null; teamId?: string }
  | { kind: 'setting-up' }
  /** The app is made; `opened` once Slack's page was opened, so the install is watched for. */
  | { kind: 'ready'; teamId: string; link: InstallLink; opened: boolean }
  | { kind: 'expired'; teamId: string }
  /** Slack says a Slack user other than the token's approved the link. */
  | { kind: 'other-user'; teamId: string }
  | { kind: 'uncertain'; teamId: string }
  | { kind: 'installed'; teamId: string }
  | { kind: 'failed'; code: string }

const INSTALL_POLL_MS = 3_000
const INSTALL_POLL_FOR_MS = 10 * 60_000

const installLink = (app: ConnectorBotSlackAppResponse): InstallLink => ({
  authorizeUrl: app.authorizeUrl,
  expiresAt: app.expiresAt ?? null
})

/** Reads the bot's Slack every 3 s for 10 minutes, one read at a time so a slow cloud never piles them
 *  up, and on return to the app; returns the stop. */
function followInstall(refresh: () => Promise<unknown>): () => void {
  const until = Date.now() + INSTALL_POLL_FOR_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const poll = () => {
    timer = setTimeout(() => {
      void refresh().then(() => {
        if (!stopped && Date.now() < until) {
          poll()
        }
      })
    }, INSTALL_POLL_MS)
  }
  poll()
  const foreground = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void refresh()
    }
  })
  return () => {
    stopped = true
    clearTimeout(timer)
    foreground.remove()
  }
}

/** Whether `expiresAt` has passed, flipping when it does. */
function useLinkExpired(expiresAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === null) {
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt])
  return expiresAt !== null && now >= expiresAt
}

export function usePhoneSlackSetup(props: {
  client: RpcClient | null
  botId: string
  /** The workspace to finish or update; none: the bot's first, or another one. */
  teamId: string | undefined
  /** The bot is already in a Slack workspace, so none means another. */
  inSlack: boolean
  /** The workspace another bot on this host is in, whose token Orca Cloud already keeps. */
  knownTeam: string | null
  slack: { view: PhoneSlackView; refresh: () => Promise<PhoneSlackView> }
  hostName: string
  t: Translate
}): {
  step: PhoneSlackSetupStep
  retry: () => void
  setUp: (teamId: string) => void
  submitToken: (token: string) => void
  approve: () => void
} {
  const { client, botId, slack, hostName, t } = props
  const [step, setStep] = useState<PhoneSlackSetupStep>({ kind: 'checking' })
  // A page left behind never goes on when a slow answer lands.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const show = (next: PhoneSlackSetupStep) => {
    if (alive.current) {
      setStep(next)
    }
  }

  const setUp = useCallback(
    async (teamId: string) => {
      // A cancelled setup sends nothing more.
      if (!client || !alive.current) {
        return
      }
      show({ kind: 'setting-up' })
      const result = await slackCall(
        () => slackSetUpApp.request(client, { botId, teamId }, { failWhenDisconnected: true }),
        slackSetUpApp.interpret
      )
      if (!result.ok) {
        show(
          result.error === 'grant_expired'
            ? { kind: 'token', reconnect: true, error: null, teamId }
            : { kind: 'failed', code: result.error }
        )
        return
      }
      // The wait reads this attempt's state, never the last one's refusal.
      await slack.refresh()
      show({ kind: 'ready', teamId, link: installLink(result.value), opened: false })
    },
    // `show` only sets state.
    [client, botId, slack]
  )

  const start = useCallback(async () => {
    show({ kind: 'checking' })
    const view = await slack.refresh()
    if (view.status !== 'ready') {
      show({ kind: 'failed', code: view.status === 'failed' ? view.error : '' })
      return
    }
    // Opened from Add a connector on a bot already in Slack: another workspace.
    if (props.teamId === undefined && props.inSlack) {
      show({ kind: 'token', reconnect: false, error: null })
      return
    }
    const state = slackTeamState(view.slack, props.teamId)
    switch (state.state) {
      case 'installed':
        return state.updateNeeded || state.updateAvailable
          ? await setUp(state.teamId)
          : show({ kind: 'installed', teamId: state.teamId })
      // Opened on the owner's own tap, so an app made earlier goes on to a fresh install link.
      case 'created':
        return await setUp(state.teamId)
      case 'uncertain':
        return show({ kind: 'uncertain', teamId: state.teamId })
      case 'grant_expired':
        return show({ kind: 'token', reconnect: true, error: null, teamId: state.teamId })
      case 'not_created': {
        const known = props.teamId ?? props.knownTeam
        return known ? await setUp(known) : show({ kind: 'token', reconnect: false, error: null })
      }
    }
  }, [slack, props.teamId, props.inSlack, props.knownTeam, setUp])

  // Once per open: the bot's re-reads make a new `start`, and running it again would set up again.
  const started = useRef(false)
  useEffect(() => {
    if (!started.current) {
      started.current = true
      void start()
    }
  }, [start])

  const submitToken = useCallback(
    async (refreshToken: string) => {
      if (step.kind !== 'token' || !client) {
        return
      }
      const { reconnect, teamId } = step
      show({ kind: 'setting-up' })
      const grant = await slackCall(
        () => slackSaveGrant.request(client, { refreshToken }, { failWhenDisconnected: true }),
        slackSaveGrant.interpret
      )
      if (!grant.ok) {
        show({
          kind: 'token',
          reconnect,
          error: slackErrorMessage(grant.error, hostName, t),
          ...(teamId ? { teamId } : {})
        })
        return
      }
      await setUp(grant.value.teamId)
    },
    [step, client, hostName, t, setUp]
  )

  const approve = useCallback(() => {
    if (step.kind !== 'ready') {
      return
    }
    openExternalLink(step.link.authorizeUrl)
    setStep({ ...step, opened: true })
  }, [step])

  // Watches for the install while Slack's page is open: every 3 s for 10 minutes, and on return to the app.
  const link = step.kind === 'ready' ? step.link : null
  const expired = useLinkExpired(link?.expiresAt ?? null)
  const watching = step.kind === 'ready' && step.opened && !expired
  const { refresh } = slack
  useEffect(() => (watching ? followInstall(refresh) : undefined), [watching, refresh])

  const waited =
    step.kind === 'ready' && step.opened && slack.view.status === 'ready'
      ? slackTeamState(slack.view.slack, step.teamId)
      : null
  const shown: PhoneSlackSetupStep = (() => {
    if (step.kind !== 'ready') {
      return step
    }
    // Still behind on permissions: the approval this flow waits for isn't in.
    if (waited?.state === 'installed' && !waited.updateNeeded && !waited.updateAvailable) {
      return { kind: 'installed', teamId: step.teamId }
    }
    if (waited?.state === 'created' && waited.oauthFailure === 'other_user') {
      return { kind: 'other-user', teamId: step.teamId }
    }
    return expired ? { kind: 'expired', teamId: step.teamId } : step
  })()

  return {
    step: shown,
    retry: () => void start(),
    setUp: (teamId) => void setUp(teamId),
    submitToken: (token) => void submitToken(token),
    approve
  }
}
