/**
 * Installs the bridge with its live collaborators; events go to the desktop host's main document.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { LEGACY_RELAY_BRIDGE_CHANNELS as CHANNELS } from '../../../../shared/remote-runtime/relay/legacy-relay-bridge-contract'
import { isRemoteCliControlAllowed } from '../../../../shared/remote-runtime/ssh/ssh-remote-cli-control'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { PtyRetirementWithoutProof } from '../../../pty/process-retirement/pty-exit-proof'
import { toAppSshPtyId } from '../../../../shared/remote-runtime/ssh/ssh-pty-id'
import { track } from '../../../telemetry/client'
import type { SshConnection } from '../../connection/ssh-connection'
import { knownSshHostPlatform } from '../../remote-host/ssh-host-platform-memo'
import { hostProps } from '../../host-server/ssh-host-server-telemetry'
import { sshDesktopHost } from '../../application/ssh-desktop-host'
import { installLegacyRelayBridge } from './legacy-relay-bridge-registry'
import { terminalsBucket } from './legacy-relay-daily-activity'

export function installLegacyRelayBridgeApplication(args: {
  store: Pick<
    Store,
    | 'getSshRemotePtyLeases'
    | 'markSshRemotePtyLease'
    | 'setSshRemotePtyLeasePendingKill'
    | 'getSshTarget'
  >
  connection: (targetId: string) => SshConnection | null
  runtime?: () => OrcaRuntimeService | null
}): void {
  const send = (channel: string, payload: unknown): void => {
    sshDesktopHost().publish(channel, payload)
  }
  installLegacyRelayBridge({
    leases: (targetId) => args.store.getSshRemotePtyLeases(targetId),
    retireLease: (targetId, relayPtyId, evidence) => {
      // Cleared first so the retire can prune the tombstone.
      args.store.setSshRemotePtyLeasePendingKill(targetId, relayPtyId, null)
      args.store.markSshRemotePtyLease(targetId, relayPtyId, evidence)
      if (evidence instanceof PtyRetirementWithoutProof) {
        args
          .runtime?.()
          ?.markPtyLivenessUnverifiable(
            toAppSshPtyId(targetId, relayPtyId),
            evidence.unverifiableReason
          )
      }
    },
    recordStop: (targetId, relayPtyId, pendingKill) =>
      args.store.setSshRemotePtyLeasePendingKill(targetId, relayPtyId, pendingKill),
    connection: args.connection,
    ...(args.runtime
      ? {
          remoteCli: {
            runtime: args.runtime,
            allowed: (targetId: string) =>
              isRemoteCliControlAllowed(args.store.getSshTarget(targetId))
          }
        }
      : {}),
    onPanesChanged: (panes) => send(CHANNELS.panes, panes),
    onData: (ptyId, data) => send(CHANNELS.data, { ptyId, data }),
    onReplay: (ptyId, replay) => send(CHANNELS.replay, { ptyId, replay }),
    // Every bridge exit is the relay's proof; no provider listener reports these to the runtime.
    onExit: (ptyId, code) => {
      send(CHANNELS.exit, { ptyId, code })
      // A negative code is a proven absence with no reported status, not an unconfirmed stop.
      const options = {
        hostExitConfirmed: true,
        ...(code < 0 ? { cause: { kind: 'unknown', reason: 'cause_unreported' } as const } : {})
      }
      try {
        void Promise.resolve(args.runtime?.()?.onPtyExit(ptyId, code, undefined, options)).catch(
          (error: unknown) => console.warn('[legacy-relay] runtime exit failed:', error)
        )
      } catch (error) {
        // The bridge still retires the pane and re-lists.
        console.warn('[legacy-relay] runtime exit failed:', error)
      }
    },
    report: (targetId, phase, terminals) => {
      try {
        track('ssh_host_server_legacy_relay_bridge', {
          phase,
          terminals: terminalsBucket(terminals),
          ...hostProps(knownSshHostPlatform(targetId))
        })
      } catch {
        // Telemetry never costs a terminal.
      }
    }
  })
}
