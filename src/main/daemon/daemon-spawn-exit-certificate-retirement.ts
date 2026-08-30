import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtySpawnResult } from '../providers/types'

/**
 * Retire every adapter's exit certificate for the session a spawn just brought up.
 *
 * Reopening a pane reuses the session id, and only the issuing adapter can clear its own
 * certificate — so a sibling generation that watched the previous incarnation die would keep
 * answering `exited` for this live one. Every spawn passes here, on both the routed and the
 * degraded path, because a certificate outliving its incarnation is a property of the shared
 * id, not of which provider happens to be installed.
 *
 * Why the incarnation and not the id alone: this call is not the last word on either side of
 * it. An exit watched while this very spawn was finalizing is already certified and must
 * survive, and a superseded generation's exit may not have landed yet — naming the run that is
 * now live settles both, where a bare delete answers only for the present.
 *
 * Why the gate: a spawn that reports the pty exited before its reply establishes no route, so
 * the certificate it just earned is the only record of that exit. A daemon too old to report an
 * incarnation cannot be told apart by the check below, so the gate is what keeps that watched
 * death from being retired into `unverifiable`.
 */
export function retireSpawnedSessionExitCertificates(
  adapters: readonly DaemonPtyAdapter[],
  result: PtySpawnResult
): void {
  if (result.exitedBeforeSpawnReply) {
    return
  }
  for (const adapter of adapters) {
    adapter.retireExitCertificate(result.id, result.incarnationId)
  }
}
