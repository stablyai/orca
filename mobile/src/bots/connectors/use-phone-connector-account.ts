// The host's Linear or GitHub link as its Orca Cloud answers it, like the desktop's bot-linear-state and
// bot-github-state: read on the route's reads and on refresh; a host the phone can't reach keeps the last.
// `failed` carries the host's code, linear_off and github_off included.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BOT_GITHUB_OFF,
  type ConnectorGitHubState
} from '../../../../src/shared/connector-bot-github-contract'
import {
  BOT_LINEAR_OFF,
  type ConnectorLinearState
} from '../../../../src/shared/connector-bot-linear-contract'
import { hostReadClient } from '../../query/host-read-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { HOST_OFFLINE, slackCall } from './bot-slack-operations'
import { gitHubStateRead, linearStateRead } from './bot-connector-people-operations'

export type PhoneAccountView<Value> =
  | { status: 'loading' }
  | { status: 'ready'; value: Value }
  | { status: 'failed'; error: string }

export type PhoneLinearView = PhoneAccountView<ConnectorLinearState>
export type PhoneGitHubView = PhoneAccountView<ConnectorGitHubState>

const SHOWN_OVER_READY = ['signed_out', BOT_LINEAR_OFF, BOT_GITHUB_OFF]

type Answer<Value> = { ok: true; value: Value } | { ok: false; error: string }

function readLinear(client: RpcClient): Promise<Answer<ConnectorLinearState>> {
  return slackCall(() => linearStateRead.request(hostReadClient(client)), linearStateRead.interpret)
}

function readGitHub(client: RpcClient): Promise<Answer<ConnectorGitHubState>> {
  return slackCall(() => gitHubStateRead.request(hostReadClient(client)), gitHubStateRead.interpret)
}

function useConnectorAccount<Value>(
  client: RpcClient | null,
  read: (client: RpcClient) => Promise<Answer<Value>>,
  enabled: boolean,
  again: number
): { view: PhoneAccountView<Value>; refresh: () => Promise<void> } {
  const [view, setView] = useState<PhoneAccountView<Value>>({ status: 'loading' })
  // One read at a time, so a slow host still lands; a refresh asked for meanwhile runs once after it,
  // and its caller waits for that read too.
  const reading = useRef<{ again: boolean; done: Promise<void> } | null>(null)
  const refresh = useCallback((): Promise<void> => {
    if (!client) {
      return Promise.resolve()
    }
    if (reading.current) {
      reading.current.again = true
      return reading.current.done
    }
    const flight = { again: true, done: Promise.resolve() }
    flight.done = (async () => {
      try {
        while (flight.again) {
          flight.again = false
          const answer = await read(client)
          if (!answer.ok && answer.error === HOST_OFFLINE) {
            return
          }
          setView((shown) =>
            answer.ok
              ? { status: 'ready', value: answer.value }
              : // A background failure keeps what showed; signed out or off is news the owner acts on.
                shown.status === 'ready' && !SHOWN_OVER_READY.includes(answer.error)
                ? shown
                : { status: 'failed', error: answer.error }
          )
        }
      } finally {
        reading.current = null
      }
    })()
    reading.current = flight
    return flight.done
  }, [client, read])
  useEffect(() => {
    if (enabled) {
      void refresh()
    }
  }, [enabled, refresh, again])
  return { view, refresh }
}

export function usePhoneLinearAccount(client: RpcClient | null, enabled: boolean, again: number) {
  return useConnectorAccount(client, readLinear, enabled, again)
}

export function usePhoneGitHubAccount(client: RpcClient | null, enabled: boolean, again: number) {
  return useConnectorAccount(client, readGitHub, enabled, again)
}
