// PAIRED-WAKE: wakes a workspace this desktop paired with (no local VM record to resume) through the
// control plane, then drops its paired server's dead connection so it reconnects at once.
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { cloudPairedSandboxesByEnvironment } from './cloud-paired-environment-ids'

type WakeResult = { ok: true; value: void } | { ok: false; error: string }

export async function wakePairedSandbox<R extends WakeResult>(
  service: { wake: (id: string) => Promise<R> },
  sandboxId: string,
  invalidate: (environmentId: string) => Promise<void> = invalidateRuntimeEnvironmentTransport
): Promise<R> {
  const result = await service.wake(sandboxId)
  if (result.ok) {
    for (const [environmentId, bound] of cloudPairedSandboxesByEnvironment()) {
      if (bound === sandboxId) {
        await invalidate(environmentId).catch(() => undefined)
      }
    }
  }
  return result
}
