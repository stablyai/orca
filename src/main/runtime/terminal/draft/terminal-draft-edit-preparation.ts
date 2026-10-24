import type {
  TerminalDraftClient,
  TerminalDraftUnavailableReason
} from '../../../../shared/terminal-draft-contract'
import type { TerminalDraftBridgeDeps } from './terminal-draft-bridge-deps'
import type { PiDraftBridgePaths } from '../../../pi/draft-bridge-directory'

type LeaseLike = {
  epoch: number
  clientId: string
  bridgeToken: string
  updatedAt: number
}

export async function prepareDraftEdit(input: {
  deps: TerminalDraftBridgeDeps
  leases: Map<string, LeaseLike>
  leaseTtlMs: number
  edit: { ptyId: string; client: TerminalDraftClient; epoch: number }
}): Promise<
  | { paths: PiDraftBridgePaths }
  | {
      result:
        | { ok: false; status: 'stale_lease'; epoch: number }
        | { ok: false; status: 'unsupported'; reason: TerminalDraftUnavailableReason }
    }
> {
  const { deps, leases, leaseTtlMs, edit } = input
  const lease = leases.get(edit.ptyId)
  const paths = deps.readSession(edit.ptyId)
  if (
    !lease ||
    lease.epoch !== edit.epoch ||
    lease.clientId !== edit.client.id ||
    !paths ||
    paths.session.token !== lease.bridgeToken ||
    deps.now() - lease.updatedAt > leaseTtlMs
  ) {
    return { result: { ok: false, status: 'stale_lease', epoch: lease?.epoch ?? 0 } }
  }
  const capability = await deps.readCapability(paths)
  if (!capability.supported) {
    return { result: { ok: false, status: 'unsupported', reason: capability.reason } }
  }
  lease.updatedAt = deps.now()
  return { paths }
}
