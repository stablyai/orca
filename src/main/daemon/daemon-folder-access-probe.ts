import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
// Answers the one question the running daemon cannot (STA-7948): would a daemon forked by THIS
// app, right now, be able to list this folder? macOS attributes a TCC grant to the process that
// forked the child, so only a fresh child of the current app binary can tell the user whether
// restarting the terminal service is the remedy or whether they must re-allow Orca first.

import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { resolveDesktopDaemonBunRuntime, type DaemonBunRuntime } from './daemon-bun-runtime'
import { isAbsolute } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { DirectoryEnumerationOutcome } from './directory-enumeration-probe'

/** `unknown` keeps "the probe could not answer" apart from every verdict it could have returned. */
export type FreshDaemonFolderAccess = DirectoryEnumerationOutcome | 'unknown'

const PROBE_DEADLINE_MS = 3_000
const PROBE_MAX_OUTPUT_BYTES = 1024
/** Everything the child needs; a scrubbed env keeps app-only state out of the probe's TCC context. */
const INHERITED_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR'] as const

// Match enumerateDirectoryOnce without importing application code into the probe runtime.
const PROBE_SCRIPT = `const fs=require('node:fs');let d;let o;try{d=fs.opendirSync(process.argv[1]);d.readSync();o='ok'}catch(e){const c=e&&e.code;o=c==='EPERM'||c==='EACCES'?'denied':c==='ENOENT'||c==='ENOTDIR'?'missing':'other'}finally{try{if(d)d.closeSync()}catch(_){}}process.stdout.write(JSON.stringify({outcome:o})+'\\n')`

function probeEnvironment(bunRuntime: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = bunRuntime ? {} : { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of INHERITED_ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined) {
      env[name] = value
    }
  }
  return env
}

function parseProbeOutcome(stdout: string): FreshDaemonFolderAccess {
  const line = stdout.trim()
  if (line.length === 0) {
    return 'unknown'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return 'unknown'
  }
  if (typeof parsed !== 'object' || parsed === null || !('outcome' in parsed)) {
    return 'unknown'
  }
  const { outcome } = parsed
  switch (outcome) {
    case 'ok':
    case 'denied':
    case 'missing':
    case 'other':
      return outcome
    default:
      return 'unknown'
  }
}

/**
 * Never throws and never outlives its deadline: this runs off the spawn path, and a folder whose
 * readability we cannot establish must read as `unknown` rather than as either verdict.
 */
export async function probeFolderAccessForFreshDaemon(
  path: string
): Promise<FreshDaemonFolderAccess> {
  // Why absolute-only: the path is the child's sole argv entry, and Node parses a leading-dash
  // argument as one of its own options.
  if (!isAbsolute(path)) {
    return 'unknown'
  }
  const deadline = Date.now() + PROBE_DEADLINE_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_DEADLINE_MS)
  let runtime: DaemonBunRuntime | null = null
  let finished = false
  let childOwnsPin = false
  try {
    runtime = await waitForPromiseWithSignal(
      resolveDesktopDaemonBunRuntime().then((resolved) => {
        if (finished || controller.signal.aborted) {
          resolved?.releaseLaunchPin?.()
        }
        return resolved
      }),
      controller.signal
    )
    const remainingMs = deadline - Date.now()
    if (controller.signal.aborted || remainingMs <= 0) {
      return 'unknown'
    }
    const usesBun = runtime !== null || Boolean(process.versions.bun)
    childOwnsPin = true
    const result = await waitForPromiseWithSignal(
      runProcess({
        program: runtime?.execPath ?? process.execPath,
        args: [...(usesBun ? bunOwnedRuntimeArgs() : []), '-e', PROBE_SCRIPT, path],
        env: probeEnvironment(usesBun),
        timeoutMs: remainingMs,
        signal: controller.signal,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        onChildTerminated: runtime?.releaseLaunchPin
      }),
      controller.signal
    )
    if (result.timedOut || result.code !== 0 || result.outputTruncated === true) {
      return 'unknown'
    }
    return parseProbeOutcome(result.stdout)
  } catch {
    return 'unknown'
  } finally {
    finished = true
    // The caller deadline does not prove the child has stopped using its runtime.
    if (!childOwnsPin) {
      runtime?.releaseLaunchPin?.()
    }
    clearTimeout(timer)
  }
}
