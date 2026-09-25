// SSH LSP relay registry (ticket 17): the main-process side of the relay
// `lsp.*` channel. Mirrors src/main/providers/ssh-filesystem-dispatch.ts — the
// SshRelaySession registers a (targetId, mux) pair here when the relay is
// established, and unregisters it on teardown/disconnect. The SSH host
// adapter (ssh-language-server-adapter.ts) looks the mux up by targetId so it
// can route `lsp.spawn/write/kill` requests and subscribe to
// `lsp.data/stderr/exit` notifications over the relay.
//
// Disconnect semantics: the registry entry is cleared on mux disposal, so a
// stale target yields `undefined` — the adapter treats that as `unverifiable`
// (execution-boundary: loss of contact is never `exited`). Reconnect
// re-registers a fresh mux; the adapter spawns a new clangd and replays open
// documents (spec §6).
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'

const sshLspRelays = new Map<string, SshChannelMultiplexer>()

export const SSH_LSP_RELAY_UNAVAILABLE_MESSAGE =
  'Remote SSH relay is not connected. Reconnect the SSH target before using C/C++ navigation.'

export function registerSshLspRelay(targetId: string, mux: SshChannelMultiplexer): void {
  sshLspRelays.set(targetId, mux)
}

export function unregisterSshLspRelay(targetId: string): void {
  sshLspRelays.delete(targetId)
}

export function getSshLspRelay(targetId: string): SshChannelMultiplexer | undefined {
  return sshLspRelays.get(targetId)
}
