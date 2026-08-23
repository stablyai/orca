import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export async function requestSshPtyDefaultShell(mux: SshChannelMultiplexer): Promise<string> {
  return (await mux.request('pty.getDefaultShell')) as string
}

export async function requestSshPtyProfiles(
  mux: SshChannelMultiplexer
): Promise<{ name: string; path: string }[]> {
  return (await mux.request('pty.getProfiles')) as { name: string; path: string }[]
}
