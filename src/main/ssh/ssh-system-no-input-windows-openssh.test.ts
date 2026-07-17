import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import type { SshTarget } from '../../shared/ssh-types'
import { buildSshArgs } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'

type DiagnosticMode = 'private-console-regular-output-strict-trust'

type DiagnosticResult = {
  mode: DiagnosticMode
  success: boolean
  timedOut: boolean
  sentinel: boolean
  stdoutEnded: boolean
  processExit: number | null | 'not-observed'
  channelClosed: boolean
  closeCode: number | null | 'not-observed'
  stderrBytes: number
  stderrTail: string
  elapsedMs: number
}

const host = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_HOST
const user = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_USER
const identityFile = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_IDENTITY
const clientHome = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_CLIENT_HOME
const launcherPath = process.env.ORCA_SSH_WINDOWS_NO_INPUT_LAUNCHER
const port = Number.parseInt(process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_PORT ?? '', 10)
const hasLiveInput = Boolean(
  host && user && identityFile && clientHome && launcherPath && Number.isInteger(port)
)

function createTarget(): SshTarget {
  return {
    id: 'live-windows-no-input-handle-diagnostic',
    label: 'live-windows-no-input-handle-diagnostic',
    host: host as string,
    port,
    username: user as string,
    identityFile: identityFile as string,
    identitiesOnly: true,
    systemSshConnectionReuse: true,
    source: 'manual'
  }
}

function buildDiagnosticSshArgs(target: SshTarget, knownHostsPath: string): string[] {
  // Why: Win32-OpenSSH ignores overridden profile variables; use only the fixture's pinned trust.
  return buildSshArgs(target, { strictKnownHostsFile: knownHostsPath })
}

async function runDiagnostic(mode: DiagnosticMode, sshArgs: string[]): Promise<DiagnosticResult> {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error('Native Windows OpenSSH client is unavailable')
  }
  const startedAt = performance.now()
  const child = spawn(
    launcherPath as string,
    ['--diagnostic-timeout-ms', '6000', sshPath, ...sshArgs, 'echo ORCA-SYSTEM-SSH-OK'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderrBytes = 0
    let stderrTail = ''
    let stdoutEnded = false
    let processExit: number | null | 'not-observed' = 'not-observed'
    let channelClosed = false
    let closeCode: number | null | 'not-observed' = 'not-observed'
    let timedOut = false
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimeout)
      const sentinel = stdout.includes('ORCA-SYSTEM-SSH-OK')
      resolve({
        mode,
        success:
          !timedOut &&
          sentinel &&
          stdoutEnded &&
          processExit === 0 &&
          channelClosed &&
          closeCode === 0,
        timedOut,
        sentinel,
        stdoutEnded,
        processExit,
        channelClosed,
        closeCode,
        stderrBytes,
        stderrTail,
        elapsedMs: performance.now() - startedAt
      })
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 8_000)
    const killTimeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      finish()
    }, 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stdout?.on('end', () => {
      stdoutEnded = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      // Why: retain only the diagnostic tail needed to classify the stuck client phase.
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-16 * 1024)
    })
    child.on('exit', (code) => {
      processExit = code
    })
    child.on('close', (code) => {
      channelClosed = true
      closeCode = code
      finish()
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimeout)
      reject(error)
    })
  })
}

describe('Windows OpenSSH no-input pinned trust arguments', () => {
  it('adds only strict fixture trust before the destination separator', () => {
    const target: SshTarget = {
      id: 'windows-no-input-contract',
      label: 'windows-no-input-contract',
      host: '127.0.0.1',
      port: 22224,
      username: 'fixture-user',
      identityFile: 'C:\\fixture\\client-key',
      identitiesOnly: true,
      systemSshConnectionReuse: true,
      source: 'manual'
    }
    const knownHostsPath = 'C:\\fixture\\client-home\\.ssh\\known_hosts'
    const productionArgs = buildSshArgs(target)
    const diagnosticArgs = buildDiagnosticSshArgs(target, knownHostsPath)
    const insertionIndex = productionArgs.indexOf('-T') + 1
    const diagnosticOnlyArgs = [
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHostsPath}`
    ]

    expect(diagnosticArgs).toEqual([
      ...productionArgs.slice(0, insertionIndex),
      ...diagnosticOnlyArgs,
      ...productionArgs.slice(insertionIndex)
    ])
    expect(diagnosticArgs).not.toContain('-vvv')
    expect(diagnosticArgs).not.toContain('StrictHostKeyChecking=no')
    expect(buildSshArgs(target)).toEqual(productionArgs)
  })
})

describe.skipIf(!hasLiveInput)('Windows OpenSSH no-input pinned-trust control', () => {
  it(
    'settles the launcher with the exact pinned fixture host file',
    { timeout: 15_000 },
    async () => {
      expect(process.platform).toBe('win32')
      const target = createTarget()
      const knownHostsPath = join(clientHome as string, '.ssh', 'known_hosts')
      const strictTrust = await runDiagnostic(
        'private-console-regular-output-strict-trust',
        buildDiagnosticSshArgs(target, knownHostsPath)
      )
      console.log(`ssh_windows_no_input_pinned_trust=${JSON.stringify({ strictTrust })}`)

      expect(strictTrust.success).toBe(true)
    }
  )
})
