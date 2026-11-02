/** R39: a WSL host's server lives in the Linux login's ~/.orca, so another Orca on this computer may share it. */
import { z } from 'zod'
import { ORCAD_PEER_DESKTOPS_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import {
  ORCAD_PEER_DESKTOPS_METHOD,
  OrcadPeerDesktopsResultSchema
} from '../../shared/orcad-peer-desktops-contract'
import { wslHostClientInstanceId } from './wsl-host-client-instance'

export type WslHostPeerDesktops =
  | { kind: 'none' }
  | { kind: 'shared'; names: string[] }
  /** An older server can't say: Remove keeps today's teardown. */
  | { kind: 'unsupported' }

const StatusCapabilitiesSchema = z.looseObject({ capabilities: z.array(z.string()).optional() })

/**
 * Another Orca counts only while its control socket is open on the server right now; a closed one
 * isn't protected. Throws when the server can't answer, so the caller refuses the teardown.
 */
export async function readWslHostPeerDesktops(
  call: (method: string, params: unknown) => Promise<unknown>,
  clientInstanceId = wslHostClientInstanceId()
): Promise<WslHostPeerDesktops> {
  const status = StatusCapabilitiesSchema.parse(await call('status.get', undefined))
  if (!status.capabilities?.includes(ORCAD_PEER_DESKTOPS_RUNTIME_CAPABILITY)) {
    return { kind: 'unsupported' }
  }
  const { peers } = OrcadPeerDesktopsResultSchema.parse(
    await call(ORCAD_PEER_DESKTOPS_METHOD, { clientInstanceId })
  )
  return peers.length > 0
    ? { kind: 'shared', names: peers.map((peer) => peer.name) }
    : { kind: 'none' }
}
