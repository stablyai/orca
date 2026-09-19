import type { SshConnectionWorkLedger } from './ssh-connection-work-ledger'

export function openTrackedSshSocket<T extends NodeJS.EventEmitter>(
  ledger: SshConnectionWorkLedger,
  open: () => T
): T {
  const work = ledger.beginChannelOpen()
  try {
    const socket = open()
    trackSshConnectionChannelLifetime(work, socket)
    return socket
  } catch (error) {
    work.markUnverifiable(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

/** Start tracking before the open callback hands the channel to another owner. */
export function trackSshConnectionChannelLifetime(
  work: ReturnType<SshConnectionWorkLedger['beginChannelOpen']>,
  value: unknown
): void {
  const channel = value as Partial<NodeJS.EventEmitter> & { closed?: boolean }
  if (!channel || typeof channel.once !== 'function' || typeof channel.on !== 'function') {
    work.markUnverifiable(new Error('ssh_connection_channel_lifetime_unverifiable'))
    return
  }
  work.bind(channel)
  if (channel.closed === true) {
    work.close()
    return
  }
  const onError = (error: Error) => work.markUnverifiable(error)
  channel.on('error', onError)
  channel.once('close', () => {
    channel.removeListener?.('error', onError)
    work.close()
  })
}
