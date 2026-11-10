import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalViewportClient } from './terminal-stream-types'

export async function updateViewportForClient(
  runtime: OrcaRuntimeService,
  ptyId: string,
  subscriptionKey: string,
  client: TerminalViewportClient,
  viewport: { cols: number; rows: number },
  defaultType: 'mobile' | 'desktop',
  // One-shot RPC can only refresh a cleanup-owned floor; streams register theirs.
  registration: 'register' | 'refresh' = 'register',
  claim = false
): Promise<{ updated: boolean; applied: boolean }> {
  const type = client.type ?? defaultType
  if (type === 'mobile') {
    return runtime.updateMobileViewport(ptyId, client.id, viewport)
  }
  // Attachment observes geometry; later claims make it authoritative.
  const updated =
    registration === 'refresh'
      ? await runtime.refreshRemoteDesktopViewer(
          ptyId,
          client.id,
          viewport.cols,
          viewport.rows,
          claim
        )
      : await runtime.updateRemoteDesktopViewer(
          ptyId,
          subscriptionKey,
          client.id,
          viewport.cols,
          viewport.rows,
          claim
        )
  return { updated, applied: updated }
}

export function chainPassiveDesktopResize(
  claimTail: Promise<boolean>,
  supportsDesktopViewportClaims: boolean,
  applyViewport: () => Promise<{ applied: boolean }>
): Promise<boolean> {
  return claimTail.then(async (priorClaimed) => {
    const result = await applyViewport().catch(() => null)
    // Passive geometry updates cannot revoke an established input claim.
    return supportsDesktopViewportClaims ? priorClaimed : result?.applied === true
  })
}
