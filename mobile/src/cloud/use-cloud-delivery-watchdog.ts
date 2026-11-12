import { useEffect, type MutableRefObject } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/connection/connection-state'
import { removeHostAndCloseClient } from '../host-catalog/host-removal-lifecycle'
import { markWaitingCloudPromptsFailed } from './cloud-prompt-queue'
import { cloudStaleHostAction } from './cloud-host-pruning'
import { useCloudHostRemoval } from './cloud-session'
import { CloudAttachError } from './cloud-workspace-attach'
import { attachErrorMessage } from './cloud-workspace-copy'
import { recordCloudWorkspaceHost } from './cloud-workspace-links'
import type { CloudWorkspaceRun } from './use-cloud-workspace-run'

/**
 * While a run waits for its host to connect: a host whose orcad refuses this phone is dropped (and,
 * if it was a saved host, paired afresh through a new grant), and a connection that never comes ends
 * in a retryable error at the run's deadline rather than a spinner.
 */
export function useCloudDeliveryWatchdog(args: {
  run: CloudWorkspaceRun
  hostState: ConnectionState
  sandboxId: string
  deliveryStarted: MutableRefObject<CloudWorkspaceRun | null>
  mountedRef: MutableRefObject<boolean>
  setRun: (run: CloudWorkspaceRun) => void
  /** Pair afresh through a new grant (the saved host's identity no longer matches). */
  repair: (intent: 'open' | 'send') => Promise<void>
}): void {
  const t = useMobileTranslation()
  const removal = useCloudHostRemoval()
  const { run, hostState, sandboxId, deliveryStarted, mountedRef, setRun, repair } = args
  useEffect(() => {
    if (run.kind !== 'delivering' || hostState === 'connected' || deliveryStarted.current === run) {
      return
    }
    const hostId = run.hostId
    // A pairing the VM refuses (revoked, rebuilt) is dropped so the next try gets a fresh grant; a
    // slow network keeps it, so retries don't pile up devices on the sandbox.
    const giveUp = (forget: boolean) => {
      if (forget) {
        void recordCloudWorkspaceHost(sandboxId, null)
        void removeHostAndCloseClient(hostId, removal.forgetHostClient, removal.queryClient).catch(
          () => undefined
        )
      }
      void markWaitingCloudPromptsFailed(sandboxId, 'not_connected').catch(() => undefined)
      setRun({
        kind: 'error',
        message: attachErrorMessage(new CloudAttachError('pairing_failed'), t),
        retry: 'send'
      })
    }
    if (hostState === 'auth-failed') {
      if (cloudStaleHostAction(run.reused) === 'repair') {
        // The saved host's orcad no longer accepts this phone (its identity changed: a rebuilt
        // sandbox). Drop it and pair afresh through a new grant; only that pairing may re-pin the
        // workspace's snapshot signer.
        deliveryStarted.current = run
        void (async () => {
          await recordCloudWorkspaceHost(sandboxId, null).catch(() => undefined)
          await removeHostAndCloseClient(
            hostId,
            removal.forgetHostClient,
            removal.queryClient
          ).catch(() => undefined)
          if (mountedRef.current) {
            await repair(run.intent)
          }
        })()
        return
      }
      giveUp(true)
      return
    }
    // One deadline per run, not per state change: a flapping connection still ends.
    const timer = setTimeout(() => giveUp(false), Math.max(0, run.connectBy - Date.now()))
    return () => clearTimeout(timer)
  }, [run, hostState, t, sandboxId, removal])
}
