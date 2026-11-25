// The host's Linear or GitHub link as its Orca Cloud answers it, like the desktop's bot-linear-state and
// bot-github-state: read on the route's reads and on refresh; a host the phone can't reach keeps the last.
// `failed` carries the host's code, linear_off and github_off included.
import { useCallback, useEffect } from 'react'
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
import {
  connectorReadCells,
  connectorReadKey,
  setConnectorRead,
  useConnectorRead,
  type ConnectorReadCell
} from './phone-connector-reads'

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

type AccountCell<Value> = ConnectorReadCell<PhoneAccountView<Value>> & {
  reading: { again: boolean; done: Promise<void> } | null
}

const accountCells = <Value>() =>
  connectorReadCells((): AccountCell<Value> => ({ value: { status: 'loading' }, reading: null }))
const linearCells = accountCells<ConnectorLinearState>()
const gitHubCells = accountCells<ConnectorGitHubState>()

function useConnectorAccount<Value>(
  client: RpcClient | null,
  cell: AccountCell<Value>,
  read: (client: RpcClient) => Promise<Answer<Value>>,
  enabled: boolean,
  again: number
): { view: PhoneAccountView<Value>; refresh: () => Promise<void> } {
  const view = useConnectorRead(cell)
  // One read at a time, so a slow host still lands; a refresh asked for meanwhile runs once after it,
  // and its caller waits for that read too.
  const refresh = useCallback((): Promise<void> => {
    if (!client) {
      return Promise.resolve()
    }
    if (cell.reading) {
      cell.reading.again = true
      return cell.reading.done
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
          const shown = cell.value
          setConnectorRead(
            cell,
            answer.ok
              ? { status: 'ready', value: answer.value }
              : // A background failure keeps what showed; signed out or off is news the owner acts on.
                shown.status === 'ready' && !SHOWN_OVER_READY.includes(answer.error)
                ? shown
                : { status: 'failed', error: answer.error }
          )
        }
      } finally {
        cell.reading = null
      }
    })()
    cell.reading = flight
    return flight.done
  }, [client, cell, read])
  useEffect(() => {
    if (enabled) {
      void refresh()
    }
  }, [enabled, refresh, again])
  return { view, refresh }
}

/** The host's Linear link, one answer for every surface of `hostKey`'s bots. */
export function usePhoneLinearAccount(
  client: RpcClient | null,
  hostKey: string,
  enabled: boolean,
  again: number
) {
  return useConnectorAccount(
    client,
    linearCells(connectorReadKey(hostKey, 'linear')),
    readLinear,
    enabled,
    again
  )
}

export function usePhoneGitHubAccount(
  client: RpcClient | null,
  hostKey: string,
  enabled: boolean,
  again: number
) {
  return useConnectorAccount(
    client,
    gitHubCells(connectorReadKey(hostKey, 'github')),
    readGitHub,
    enabled,
    again
  )
}
