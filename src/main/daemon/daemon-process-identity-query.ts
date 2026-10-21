import { execFile, execFileSync } from 'node:child_process'

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
      ...(options?.utc ? { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } } : {})
    })
    return parsePsProcessIdentity(output, options?.utc)
  } catch {
    return null
  }
}

export async function getPsProcessIdentityAsync(pid: number): Promise<ProcessIdentity | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
        {
          encoding: 'utf8',
          timeout: PS_IDENTITY_TIMEOUT_MS
        },
        (error, output) => {
          if (error) {
            reject(error)
            return
          }
          resolve(output)
        }
      )
    })
    return parsePsProcessIdentity(stdout)
  } catch {
    return null
  }
}
