import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

import { forceStopRelayForTarget } from './ssh-relay-reset'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import type { SshConnection } from './ssh-connection'

const TARGET_PID = '11111'
const UNRELATED_PID = '22222'

type LsofMode = 'match' | 'empty'

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function capturedResetScript(): Promise<string> {
  const conn = {} as SshConnection
  await forceStopRelayForTarget(conn, 'ssh-1')
  return vi.mocked(execCommand).mock.lastCall?.[1] ?? ''
}

async function runResetScript(lsofMode: LsofMode): Promise<{
  killCalls: string[]
  pgrepCalls: string[]
  socketExists: boolean
}> {
  const script = await capturedResetScript()
  const home = mkdtempSync(join(tmpdir(), 'orca-'))
  const binDir = join(home, 'bin')
  const socketDir = join(home, '.orca-remote')
  const socketPath = join(socketDir, relaySocketNameForInstanceId('ssh-1'))
  const killLog = join(home, 'kill.log')
  const pgrepLog = join(home, 'pgrep.log')
  mkdirSync(binDir)
  mkdirSync(socketDir, { recursive: true })
  writeFileSync(killLog, '')
  writeFileSync(pgrepLog, '')

  const lsofBody =
    lsofMode === 'empty'
      ? 'exit 1'
      : `case " $* " in
  *" -a "*) printf '%s\\n' "$TARGET_PID" ;;
  *) printf '%s\\n' "$TARGET_PID" "$UNRELATED_PID" ;;
esac`
  writeExecutable(join(binDir, 'lsof'), lsofBody)
  writeExecutable(
    join(binDir, 'pgrep'),
    `printf 'called\\n' >> "$PGREP_LOG"
printf '%s\\n' "$TARGET_PID"`
  )
  writeExecutable(join(binDir, 'sleep'), 'exit 0')

  const server = createServer()
  try {
    await listenOnSocket(server, socketPath)
    execFileSync(
      '/bin/sh',
      [
        '-c',
        `kill() {
  printf '%s\\n' "$*" >> "$KILL_LOG"
}
eval "$RESET_SCRIPT"`
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          KILL_LOG: killLog,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          PGREP_LOG: pgrepLog,
          RESET_SCRIPT: script,
          TARGET_PID,
          UNRELATED_PID
        }
      }
    )
    return {
      killCalls: readFileSync(killLog, 'utf8').split('\n').filter(Boolean),
      pgrepCalls: readFileSync(pgrepLog, 'utf8').split('\n').filter(Boolean),
      socketExists: existsSync(socketPath)
    }
  } finally {
    await closeServer(server)
    rmSync(home, { recursive: true, force: true })
  }
}

describe('forceStopRelayForTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('targets only the relay socket for the requested SSH target', async () => {
    const conn = {} as SshConnection

    await forceStopRelayForTarget(conn, 'ssh-1')

    const command = vi.mocked(execCommand).mock.calls[0]?.[1] ?? ''
    expect(execCommand).toHaveBeenCalledWith(conn, expect.any(String))
    expect(command).toContain(`sock_name='${relaySocketNameForInstanceId('ssh-1')}'`)
    expect(command).toContain('lsof -t -a -U "$sock"')
    expect(command).toContain('pgrep -f "$sock_name"')
    expect(command).toContain('rm -f "$sock"')
  })

  it.skipIf(process.platform === 'win32')(
    'never passes unrelated unix-socket holders to kill',
    async () => {
      const result = await runResetScript('match')

      expect(result.killCalls).toEqual([`-TERM ${TARGET_PID}`, `-KILL ${TARGET_PID}`])
      expect(result.killCalls.join(' ')).not.toContain(UNRELATED_PID)
      expect(result.pgrepCalls).toEqual([])
      expect(result.socketExists).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the command-line fallback when lsof cannot match the socket',
    async () => {
      const result = await runResetScript('empty')

      expect(result.killCalls).toEqual([`-TERM ${TARGET_PID}`, `-KILL ${TARGET_PID}`])
      expect(result.pgrepCalls).toEqual(['called'])
      expect(result.socketExists).toBe(false)
    }
  )
})
