import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export async function shutdownSshPty(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
): Promise<void> {
  await mux.request(
    'pty.shutdown',
    {
      id: relayPtyId,
      immediate: opts.immediate ?? false,
      keepHistory: opts.keepHistory ?? false
    },
    opts.deadlineMs === undefined
      ? undefined
      : { timeoutMs: Math.max(1, opts.deadlineMs - Date.now()) }
  )
}
