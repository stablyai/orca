import { execFile, execFileSync } from 'node:child_process'
import { psLocaleEnvironment } from '../../shared/ps-locale-environment'

const PS_IDENTITY_TIMEOUT_MS = 2_000

export type ProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

function parsePsProcessIdentity(output: string, utc = false): ProcessIdentity {
  // BSD ps formats lstart as a fixed-width 24-character timestamp.
  const startedAtMs = Date.parse(output.slice(0, 24) + (utc ? ' UTC' : ''))
  return {
    commandLine: output.slice(24).trim(),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null
  }
}

export function getPsProcessIdentity(
  pid: number,
  options?: { utc?: boolean }
): ProcessIdentity | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
      env: options?.utc ? { ...process.env, TZ: 'UTC', LC_ALL: 'C' } : psLocaleEnvironment()
    })
    return parsePsProcessIdentity(output, options?.utc)
  } catch {
    return null
  }
}

async function runPsAsync(pid: number, fields: string[]): Promise<string | null> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-p', String(pid), ...fields],
        { encoding: 'utf8', env: psLocaleEnvironment(), timeout: PS_IDENTITY_TIMEOUT_MS },
        (error, output) => (error ? reject(error) : resolve(output))
      )
    })
  } catch {
    return null
  }
}

export async function getPsProcessIdentityAsync(pid: number): Promise<ProcessIdentity | null> {
  const stdout = await runPsAsync(pid, ['-o', 'lstart=', '-o', 'command='])
  return stdout === null ? null : parsePsProcessIdentity(stdout)
}

/** Node's ppid is only the caller's, so another process's parent comes from ps. */
export async function getPsParentProcessAsync(
  pid: number
): Promise<{ parentPid: number; commandLine: string } | null> {
  const stdout = await runPsAsync(pid, ['-o', 'ppid=', '-o', 'command='])
  const match = stdout === null ? null : /^\s*(\d+)\s+(.*)$/s.exec(stdout)
  return match ? { parentPid: Number(match[1]), commandLine: match[2].trim() } : null
}
