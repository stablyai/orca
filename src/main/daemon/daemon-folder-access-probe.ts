// Probe from a fresh child of the current app: its TCC access may differ from the existing daemon.

import { isAbsolute } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { DirectoryEnumerationOutcome } from './directory-enumeration-probe'

export type FreshDaemonFolderAccess = DirectoryEnumerationOutcome | 'unknown'

const PROBE_DEADLINE_MS = 3_000
const PROBE_MAX_OUTPUT_BYTES = 1024
/** Keep app-only environment state out of the child's TCC context. */
const INHERITED_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR'] as const

// Inline enumerateDirectoryOnce's errno mapping because this plain-Node child cannot load the app bundle.
const PROBE_SCRIPT = `const fs=require('node:fs');let d;let o;try{d=fs.opendirSync(process.argv[1]);d.readSync();o='ok'}catch(e){const c=e&&e.code;o=c==='EPERM'||c==='EACCES'?'denied':c==='ENOENT'||c==='ENOTDIR'?'missing':'other'}finally{try{if(d)d.closeSync()}catch(_){}}process.stdout.write(JSON.stringify({outcome:o})+'\\n')`

function probeEnvironment(): NodeJS.ProcessEnv {
  // Match the daemon's Node mode when process.execPath is Electron.
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
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

/** Unresolved readability stays unknown; timeout and errors must not imply denial. */
export async function probeFolderAccessForFreshDaemon(
  path: string
): Promise<FreshDaemonFolderAccess> {
  // Node could parse a relative path beginning with a dash as its own option.
  if (!isAbsolute(path)) {
    return 'unknown'
  }
  try {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', PROBE_SCRIPT, path],
      env: probeEnvironment(),
      timeoutMs: PROBE_DEADLINE_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
    })
    if (result.timedOut || result.code !== 0 || result.outputTruncated === true) {
      return 'unknown'
    }
    return parseProbeOutcome(result.stdout)
  } catch {
    return 'unknown'
  }
}
