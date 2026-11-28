import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { runProcess } from '@orca/process-host'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const MAX_LAUNCH_BYTES = 256 * 1024
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// Bash 3.2 on macOS supports a timed NUL-delimited read. Opening the FIFO read/write
// means a controller crash cannot leave a child waiting forever for a writer.
const gateScript =
  'set +x +v; set -e; unset payload key; exec 3<> "$1"; IFS= read -r -t 30 -d "" payload <&3 || exit 124; exec 3>&-; while IFS= read -r key; do case "$key" in REX_*|OSC7577_TOKEN) ;; *) export -n "$key" ;; esac; done < <(compgen -e); eval "$payload"'

function quote(value: string): string {
  if (value.includes('\0')) {
    throw new Error('NUL in Rex launch argument')
  }
  return quotePosixShell(value)
}

export function isRexLaunchEnvName(name: string): boolean {
  // Do not replace server-issued capabilities or the shell's tracing controls.
  return (
    ENV_NAME.test(name) &&
    !/^(?:REX_|OSC7577_TOKEN$|BASHOPTS$|SHELLOPTS$|BASH_XTRACEFD$|PS4$)/.test(name)
  )
}

function validateEnvName(name: string): void {
  if (!isRexLaunchEnvName(name)) {
    throw new Error('Unsupported Rex launch environment key')
  }
}

export function encodeRexLaunch(
  argv: string[],
  env: Record<string, string> = {},
  envToDelete: readonly string[] = []
): Buffer {
  if (argv.length === 0 || !argv[0].startsWith('/')) {
    throw new Error('Absolute Rex launch executable required')
  }
  const deleted = new Set(envToDelete)
  const commands: string[] = []
  for (const [key, value] of Object.entries(env)) {
    validateEnvName(key)
    if (!deleted.has(key)) {
      commands.push(`export ${quote(`${key}=${value}`)}`)
    }
  }
  for (const key of deleted) {
    validateEnvName(key)
    commands.push(`unset ${quote(key)}`)
  }
  commands.push(`exec ${argv.map(quote).join(' ')}`)
  const bytes = Buffer.from(`${commands.join('\n')}\0`)
  if (bytes.length > MAX_LAUNCH_BYTES) {
    throw new Error('Rex launch exceeds transport limit')
  }
  return bytes
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** No launch payload is written to a regular file or included in Rex's persisted argv. */
export async function prepareRexLaunchGate(payload: Buffer): Promise<{
  directory: string
  command: string[]
  release: () => Promise<void>
  discard: () => void
}> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-rex-gate-')).catch((error: unknown) => {
    payload.fill(0)
    throw error
  })
  const fifo = join(directory, 'launch')
  try {
    const result = await runProcess({
      program: '/usr/bin/mkfifo',
      args: ['-m', '600', fifo],
      timeoutMs: 3000,
      maxOutputBytes: 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Rex launch FIFO creation failed')
    }
  } catch (error) {
    payload.fill(0)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let settled = false
  const discard = () => {
    settled = true
    payload.fill(0)
  }
  return {
    discard,
    directory,
    // Privileged mode disables inherited shell startup files/functions; it does not elevate uid.
    command: ['/bin/bash', '--noprofile', '--norc', '-p', '-c', gateScript, 'orca-rex-gate', fifo],
    release: async () => {
      if (settled) {
        throw new Error('Rex launch gate already settled')
      }
      settled = true
      const deadline = Date.now() + 5000
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        while (!handle) {
          if (Date.now() >= deadline) {
            throw new Error('Rex launch reader unavailable')
          }
          try {
            handle = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
          } catch (error) {
            if (!hasCode(error, 'ENXIO')) {
              throw error
            }
            await delay(20)
          }
        }
        let offset = 0
        while (offset < payload.length) {
          if (Date.now() >= deadline) {
            throw new Error('Rex launch transfer timed out')
          }
          try {
            const { bytesWritten } = await handle.write(payload, offset, payload.length - offset)
            offset += bytesWritten
            if (!bytesWritten) {
              await delay(10)
            }
          } catch (error) {
            if (!hasCode(error, 'EAGAIN')) {
              throw error
            }
            await delay(10)
          }
        }
      } finally {
        discard()
        try {
          await handle?.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    }
  }
}
