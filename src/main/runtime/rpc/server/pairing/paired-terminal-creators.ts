// Terminals a paired client opened. `orca pair` run in one tags its offer with that client, so
// revoking the client also revokes the link it minted. The shell can drop the handle, and the map
// starts empty after a host restart; this catches the honest case, not a determined one.
import { getActiveRpcCaller, getActiveRpcClientInstanceId } from '../../callers/active-call'

const MAX_TRACKED_TERMINALS = 10_000

type TerminalCreator = { deviceId: string; clientInstanceId?: string }

const creators = new Map<string, TerminalCreator>()

/** A terminal opened under a paired client's RPC is that client's: called where the runtime spawns
 *  one, and where a window spawns one for the client. */
export function noteCallerOpenedTerminal(handle: string | null | undefined): void {
  const caller = getActiveRpcCaller()
  if (handle && caller?.kind === 'paired-device') {
    const clientInstanceId = getActiveRpcClientInstanceId()
    notePairedTerminal(handle, {
      deviceId: caller.deviceId,
      ...(clientInstanceId ? { clientInstanceId } : {})
    })
  }
}

function notePairedTerminal(handle: string, creator: TerminalCreator): void {
  creators.delete(handle)
  creators.set(handle, creator)
  if (creators.size > MAX_TRACKED_TERMINALS) {
    const oldest = creators.keys().next().value
    if (oldest !== undefined) {
      creators.delete(oldest)
    }
  }
}

export function pairedCreatorOfTerminal(handle: string | undefined): string | undefined {
  return handle === undefined ? undefined : creators.get(handle)?.deviceId
}

/** The desktop installation that opened it, when its client declared one. */
export function pairedCreatorInstanceOfTerminal(handle: string | undefined): string | undefined {
  return handle === undefined ? undefined : creators.get(handle)?.clientInstanceId
}
