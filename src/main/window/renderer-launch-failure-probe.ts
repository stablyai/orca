import { runProcess } from '@orca/process-host'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { errnoCodeOrUnknown } from '../../shared/errno-code'

/** 'ok' when a throwaway child could start, the spawn errno (EAGAIN = per-user process limit), or 'skipped' on Windows. */
export type RendererLaunchProbeResult = string

const PROBE_TIMEOUT_MS = 5_000

/** Chromium launch-failed hides the spawn errno; probe another child to distinguish OS-wide process refusal (macOS 1003). */
export async function probeRendererLaunchCapacity(
  platform: NodeJS.Platform = process.platform
): Promise<RendererLaunchProbeResult> {
  // Windows EDR scores per-operation spawn bursts; omit this diagnostic child (windows-edr-posture.md).
  if (platform === 'win32') {
    return 'skipped'
  }
  try {
    // Any started child proves spawn headroom regardless of exit status; POSIX hosts provide /bin/sh.
    await runProcess({
      program: '/bin/sh',
      args: ['-c', 'exit 0'],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4096
    })
    return 'ok'
  } catch (error) {
    return errnoCodeOrUnknown(error)
  }
}

// Coalesce duplicate render-process-gone events (~10ms apart) for one failed launch.
const PROBE_COALESCE_MS = 100
let lastProbe: { startedAt: number; result: Promise<RendererLaunchProbeResult> } | null = null

export function recordRendererLaunchFailureProbe(
  details: Pick<Electron.RenderProcessGoneDetails, 'exitCode'>,
  now: number = Date.now()
): Promise<RendererLaunchProbeResult> {
  if (
    lastProbe &&
    now - lastProbe.startedAt >= 0 &&
    now - lastProbe.startedAt < PROBE_COALESCE_MS
  ) {
    return lastProbe.result
  }
  // Never reject from this fire-and-forget render-process-gone diagnostic.
  const result = probeRendererLaunchCapacity().then((spawnError) => {
    try {
      recordDurableCrashBreadcrumb('renderer_launch_failed_probe', {
        spawnError,
        exitCode: details.exitCode ?? null
      })
    } catch {
      // Diagnostics only.
    }
    return spawnError
  })
  lastProbe = { startedAt: now, result }
  return result
}
