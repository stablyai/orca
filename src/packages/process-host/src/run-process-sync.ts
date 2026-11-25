import { resolveSpawn, type ResolvedSpawn } from './spawn-resolution'
import { spawnNativeProcessSync } from './native-process-spawn'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import type { ProcessSpec, ProcessResult } from './process-spec'
import { DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'

/** Prefer runProcess; reserve blocking execution for synchronous entry points and teardown. */
export function runProcessSync(spec: ProcessSpec): ProcessResult {
  const resolved = resolveSpawn(spec, process.platform)
  return runResolvedProcessSync(spec, resolved)
}

function runResolvedProcessSync(spec: ProcessSpec, resolved: ResolvedSpawn): ProcessResult {
  const result = spawnNativeProcessSync(
    resolved.file,
    resolved.args,
    {
      ...resolved.options,
      input: spec.input,
      timeout: spec.timeoutMs === null ? undefined : (spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS),
      maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      // Keep raw output without applying the nonexistent 'buffer' encoding to string stdin.
      encoding: null
    },
    hasSpawnObserver() ? notifySpawnObserver : undefined
  )
  const timedOut = result.error
    ? 'code' in result.error && result.error.code === 'ETIMEDOUT'
    : false
  if (result.error && !timedOut) {
    throw result.error
  }
  return {
    code: result.status,
    signal: result.signal,
    stdout: spec.captureStdoutAsBytes ? '' : (result.stdout?.toString('utf8') ?? ''),
    ...(spec.captureStdoutAsBytes ? { stdoutBytes: result.stdout ?? Buffer.alloc(0) } : {}),
    stderr: spec.captureStderrAsBytes ? '' : (result.stderr?.toString('utf8') ?? ''),
    ...(spec.captureStderrAsBytes ? { stderrBytes: result.stderr ?? Buffer.alloc(0) } : {}),
    // ENOBUFS is rethrown above, so truncated output never reaches this result.
    outputTruncated: false,
    // SIGTERM can be deliberate; only ETIMEDOUT proves a timeout.
    timedOut
  }
}
