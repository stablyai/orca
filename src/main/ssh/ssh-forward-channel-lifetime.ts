import type { Client } from 'ssh2'
import { trackSshConnectionChannelLifetime } from './ssh-connection-channel-lifetime'
import type { SshConnectionWorkLedger } from './ssh-connection-work-ledger'

/** The channel remains tracked until physical close, including late open replies. */
export function forwardTrackedSshStreamLocalChannel(
  ledger: SshConnectionWorkLedger,
  client: Client,
  ...args: Parameters<Client['openssh_forwardOutStreamLocal']>
): void {
  const opening = ledger.beginChannelOpen()
  const [socketPath, callback] = args
  try {
    client.openssh_forwardOutStreamLocal(socketPath, (error, channel) => {
      if (error) {
        opening.close(error)
      } else {
        trackSshConnectionChannelLifetime(opening, channel)
      }
      callback(error, channel)
    })
  } catch (error) {
    opening.markUnverifiable(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

export function forwardTrackedSshChannel(
  ledger: SshConnectionWorkLedger,
  client: Client,
  localSocket: object,
  ...args: Parameters<Client['forwardOut']>
): void {
  const opening = ledger.beginChannelOpen()
  trackSshConnectionChannelLifetime(ledger.beginChannelOpen(), localSocket)
  const [sourceHost, sourcePort, host, port, callback] = args
  try {
    client.forwardOut(sourceHost, sourcePort, host, port, (error, channel) => {
      if (error) {
        opening.close(error)
      } else {
        trackSshConnectionChannelLifetime(opening, channel)
      }
      callback?.(error, channel)
    })
  } catch (error) {
    opening.markUnverifiable(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}
