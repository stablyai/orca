import { runProcess } from '@orca/process-host'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

/** 'ok' when a throwaway child could start, the spawn errno (EAGAIN = per-user process limit), or 'skipped' on Windows. */
export type RendererLaunchProbeResult = string

const PROBE_TIMEOUT_MS = 5_000
const ERRNO_CODE = /^E[A-Z0-9]{1,15}$/

export function classifyLaunchProbeError(error: unknown): RendererLaunchProbeResult {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return typeof code === 'string' && ERRNO_CODE.test(code) ? code : 'unknown'
}

/**
 * Chromium reports any failed helper spawn as launch-failed (macOS exit 1003 = LAUNCH_RESULT_FAILURE),
 * so spawn an unrelated child to learn whether the OS is refusing every new process.
 */
export async function probeRendererLaunchCapacity(
  platform: NodeJS.Platform = process.platform
): Promise<RendererLaunchProbeResult> {
  // Why skip Windows: a short-lived child per failed launch is the per-operation spawn burst EDR scores (windows-edr-posture.md).
  if (platform === 'win32') {
    return 'skipped'
  }
  try {
    // Exit status is irrelevant: a child that started proves spawn headroom. /bin/sh is at a fixed path on every POSIX host.
    await runProcess({
      program: '/bin/sh',
      args: ['-c', 'exit 0'],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4096
    })
    return 'ok'
  } catch (error) {
    return classifyLaunchProbeError(error)
  }
}

// Electron emits render-process-gone twice (~10ms apart) for one failed launch; probe and record it once.
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
  // Never rejects: callers fire-and-forget it from the render-process-gone handler.
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
