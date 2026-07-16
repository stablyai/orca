import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import {
  queryWindowsProcessDescendants,
  type WindowsProcessCandidate
} from './windows-foreground-process-rows'
import {
  encodeWindowsCodexShellHandoffConfig,
  WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT,
  type WindowsCodexShellHandoffConfig
} from './windows-codex-shell-handoff'
import { resolveWindowsPowerShellSpawnChain } from './windows-powershell-executable'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'

const describeWindows = process.platform === 'win32' ? describe : describe.skip
const PHASE_TIMEOUT_MS = 12_000
const EXIT_TIMEOUT_MS = 8_000

const SURROGATE_AGENT_SCRIPT = String.raw`
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true)
}
process.stdin.resume()

let pending = ''
let reportedCtrlC = false
const reportCtrlC = () => {
  if (reportedCtrlC) return
  reportedCtrlC = true
  process.stdout.write('AGENT_CTRL_C\r\n')
}

process.on('SIGINT', reportCtrlC)

const handleLine = (line) => {
  if (line === 'size') {
    process.stdout.write('AGENT_SIZE:' + process.stdout.columns + 'x' + process.stdout.rows + '\r\n')
    return
  }
  if (line === 'agent-exit') {
    process.stdout.write('\x1b[?1049lAGENT_EXITING\r\n', () => process.exit(0))
    return
  }
  process.stdout.write('AGENT_ECHO:' + line + '\r\n')
}

process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\x03') {
      reportCtrlC()
    } else if (char === '\r' || char === '\n') {
      if (pending) {
        const line = pending
        pending = ''
        handleLine(line)
      }
    } else {
      pending += char
    }
  }
})

process.stdout.write('\x1b[?1049hAGENT_READY\r\n')
`

const TEARDOWN_SURROGATE_AGENT_SCRIPT = String.raw`
const { spawn } = require('node:child_process')
const token = process.argv[1]
const grandchild = spawn(
  process.execPath,
  ['-e', "process.stdout.write('GRANDCHILD_READY\\r\\n'); setInterval(() => {}, 1000)", token],
  { stdio: 'inherit', windowsHide: true }
)

grandchild.once('spawn', () => {
  process.stdout.write('TEARDOWN_AGENT_READY:' + process.pid + ':' + grandchild.pid + '\r\n')
})
grandchild.once('error', (error) => {
  process.stderr.write('GRANDCHILD_ERROR:' + error.message + '\r\n')
  process.exit(2)
})
setInterval(() => {}, 1000)
`

function stringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1]))
  )
}

function outputTail(output: string): string {
  return output.slice(-4_000)
}

async function waitForOutput(readOutput: () => string, marker: string): Promise<void> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS
  while (!readOutput().includes(marker)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${marker}. PTY output:\n${outputTail(readOutput())}`)
    }
    await delay(25)
  }
}

async function waitForProcessTree(
  rootPid: number,
  description: string,
  predicate: (rows: WindowsProcessCandidate[]) => boolean
): Promise<WindowsProcessCandidate[]> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS
  let lastRows: WindowsProcessCandidate[] | null = null
  while (Date.now() < deadline) {
    lastRows = await queryWindowsProcessDescendants(rootPid, { fresh: true })
    if (lastRows && predicate(lastRows)) {
      return lastRows
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(lastRows)}`)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForPidsToExit(pids: ReadonlySet<number>): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  let alive = [...pids].filter(isPidAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(25)
    alive = [...pids].filter(isPidAlive)
  }
  expect(alive, `Handoff process tree left live PIDs: ${alive.join(', ')}`).toEqual([])
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

describeWindows('Windows Codex shell handoff ConPTY integration', () => {
  it(
    'owns one real ConPTY across the native-agent and restored-PowerShell phases',
    { timeout: 45_000 },
    async () => {
      const cwd = process.cwd()
      const shellPath = resolveWindowsPowerShellSpawnChain('pwsh.exe').find((candidate) =>
        ['pwsh.exe', 'powershell.exe'].includes(basename(candidate).toLowerCase())
      )
      expect(shellPath, 'Windows must provide a real PowerShell executable').toBeTruthy()
      if (!shellPath) {
        return
      }

      const shellLaunch = resolveWindowsShellLaunchArgs(shellPath, cwd, cwd)
      const token = `ORCA_HANDOFF_CONPTY_${process.pid}_${Date.now()}`
      const config: WindowsCodexShellHandoffConfig = {
        agentFile: process.execPath,
        agentArgs: ['-e', SURROGATE_AGENT_SCRIPT, token],
        agentEnvToDelete: [],
        agentEnv: { ORCA_HANDOFF_CONPTY_TEST: token },
        shellAttempts: [
          { file: shellPath, args: shellLaunch.shellArgs, cwd: shellLaunch.effectiveCwd }
        ],
        agentFallbackAttempts: [
          { file: shellPath, args: shellLaunch.shellArgs, cwd: shellLaunch.effectiveCwd }
        ]
      }
      const proc = pty.spawn(
        process.execPath,
        [
          '-e',
          WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT,
          encodeWindowsCodexShellHandoffConfig(config)
        ],
        {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: { ...stringEnv(), TERM: 'xterm-256color' }
        }
      )

      let output = ''
      let exited = false
      proc.onData((data) => {
        output += data
      })
      const exitPromise = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
        proc.onExit((event) => {
          exited = true
          resolve(event)
        })
      })
      const trackedPids = new Set<number>([proc.pid])

      try {
        await waitForOutput(() => output, 'AGENT_READY')
        const agentTree = await waitForProcessTree(proc.pid, 'surrogate agent process', (rows) =>
          rows.some((row) => row.command.includes(token))
        )
        for (const row of agentTree) {
          trackedPids.add(row.pid)
        }
        expect(
          agentTree.some((row) => ['pwsh.exe', 'powershell.exe'].includes(row.name.toLowerCase()))
        ).toBe(false)
        const agentProcess = agentTree.find((row) => row.command.includes(token))
        expect(agentProcess).toBeTruthy()

        proc.resize(111, 37)
        await delay(100)
        proc.write('size\r')
        await waitForOutput(() => output, 'AGENT_SIZE:111x37')
        proc.write('unicode-\u03a9\u96ea\r')
        await waitForOutput(() => output, 'AGENT_ECHO:unicode-\u03a9\u96ea')
        proc.write('\x03')
        await waitForOutput(() => output, 'AGENT_CTRL_C')

        proc.write('agent-exit\r')
        await waitForOutput(() => output, 'AGENT_EXITING')
        const shellName = basename(shellPath).toLowerCase()
        const shellTree = await waitForProcessTree(
          proc.pid,
          'restored PowerShell process',
          (rows) => rows.some((row) => row.name.toLowerCase() === shellName)
        )
        for (const row of shellTree) {
          trackedPids.add(row.pid)
        }
        expect(shellTree.some((row) => row.pid === agentProcess?.pid)).toBe(false)
        expect(shellTree.some((row) => row.name.toLowerCase() === shellName)).toBe(true)

        proc.write("Write-Output ('SHELL_' + 'READY')\r")
        await waitForOutput(() => output, 'SHELL_READY')
        proc.write("Write-Output ('SHELL_UNICODE:' + [char]0x03A9 + [char]0x96EA)\r")
        await waitForOutput(() => output, 'SHELL_UNICODE:\u03a9\u96ea')
        proc.write(
          "$size = $Host.UI.RawUI.WindowSize; Write-Output (('SHELL_' + 'SIZE:') + $size.Width + 'x' + $size.Height)\r"
        )
        await waitForOutput(() => output, 'SHELL_SIZE:111x37')

        proc.write(
          "Write-Output ('SHELL_SLEEP_' + 'START'); Start-Sleep -Seconds 60; Write-Output ('SHELL_SLEEP_' + 'END')\r"
        )
        await waitForOutput(() => output, 'SHELL_SLEEP_START')
        proc.write('\x03')
        await delay(200)
        proc.write("Write-Output ('SHELL_CTRL_C_' + 'RECOVERED')\r")
        await waitForOutput(() => output, 'SHELL_CTRL_C_RECOVERED')
        expect(output).not.toContain('SHELL_SLEEP_END')

        // Why: ConPTY may inject cursor-visibility frames while applying a
        // screen-buffer switch, so assert semantic ordering rather than byte adjacency.
        const altEnter = output.indexOf('\x1b[?1049h')
        const agentReady = output.indexOf('AGENT_READY')
        const altLeave = output.indexOf('\x1b[?1049l')
        const agentExiting = output.indexOf('AGENT_EXITING')
        const shellReady = output.indexOf('SHELL_READY')
        expect(altEnter, outputTail(output)).toBeGreaterThanOrEqual(0)
        expect(agentReady, outputTail(output)).toBeGreaterThan(altEnter)
        expect(altLeave, outputTail(output)).toBeGreaterThan(agentReady)
        expect(agentExiting, outputTail(output)).toBeGreaterThan(altLeave)
        expect(shellReady, outputTail(output)).toBeGreaterThan(agentExiting)

        proc.write('exit\r')
        const exit = await withTimeout(
          exitPromise,
          EXIT_TIMEOUT_MS,
          `Handoff PTY did not exit. Output:\n${outputTail(output)}`
        )
        expect(exit.exitCode).toBe(0)
        await waitForPidsToExit(trackedPids)
      } finally {
        if (!exited) {
          try {
            proc.kill()
          } catch {
            // The PTY may have exited between the state check and cleanup.
          }
          await withTimeout(
            exitPromise,
            EXIT_TIMEOUT_MS,
            'Failed to tear down handoff ConPTY'
          ).catch(() => undefined)
        }
      }
    }
  )

  it('reaps the active agent process tree when the pane closes', { timeout: 30_000 }, async () => {
    const cwd = process.cwd()
    const shellPath = resolveWindowsPowerShellSpawnChain('pwsh.exe').find((candidate) =>
      ['pwsh.exe', 'powershell.exe'].includes(basename(candidate).toLowerCase())
    )
    expect(shellPath, 'Windows must provide a real PowerShell executable').toBeTruthy()
    if (!shellPath) {
      return
    }

    const shellLaunch = resolveWindowsShellLaunchArgs(shellPath, cwd, cwd)
    const token = `ORCA_HANDOFF_TEARDOWN_${process.pid}_${Date.now()}`
    const config: WindowsCodexShellHandoffConfig = {
      agentFile: process.execPath,
      agentArgs: ['-e', TEARDOWN_SURROGATE_AGENT_SCRIPT, token],
      agentEnvToDelete: [],
      agentEnv: { ORCA_HANDOFF_CONPTY_TEST: token },
      shellAttempts: [
        { file: shellPath, args: shellLaunch.shellArgs, cwd: shellLaunch.effectiveCwd }
      ],
      agentFallbackAttempts: [
        { file: shellPath, args: shellLaunch.shellArgs, cwd: shellLaunch.effectiveCwd }
      ]
    }
    const proc = pty.spawn(
      process.execPath,
      ['-e', WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT, encodeWindowsCodexShellHandoffConfig(config)],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: { ...stringEnv(), TERM: 'xterm-256color' }
      }
    )

    let output = ''
    let exited = false
    let killIssued = false
    proc.onData((data) => {
      output += data
    })
    const exitPromise = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      proc.onExit((event) => {
        exited = true
        resolve(event)
      })
    })
    const trackedPids = new Set<number>([proc.pid])

    try {
      await waitForOutput(() => output, 'TEARDOWN_AGENT_READY:')
      await waitForOutput(() => output, 'GRANDCHILD_READY')
      const marker = /TEARDOWN_AGENT_READY:(\d+):(\d+)/.exec(output)
      expect(marker, outputTail(output)).toBeTruthy()
      const agentPid = Number(marker?.[1])
      const grandchildPid = Number(marker?.[2])
      expect(Number.isSafeInteger(agentPid)).toBe(true)
      expect(Number.isSafeInteger(grandchildPid)).toBe(true)

      const agentTree = await waitForProcessTree(
        proc.pid,
        'active agent and grandchild',
        (rows) =>
          rows.some((row) => row.pid === agentPid) && rows.some((row) => row.pid === grandchildPid)
      )
      for (const row of agentTree) {
        trackedPids.add(row.pid)
      }
      expect(agentTree.some((row) => row.pid === agentPid && row.command.includes(token))).toBe(
        true
      )
      expect(
        agentTree.some((row) => row.pid === grandchildPid && row.command.includes(token))
      ).toBe(true)
      expect(
        agentTree.some((row) => ['pwsh.exe', 'powershell.exe'].includes(row.name.toLowerCase()))
      ).toBe(false)

      // Why: pane close uses node-pty's ConPTY kill, which must reap the
      // handoff host and every process sharing the active agent's console.
      proc.kill()
      killIssued = true
      await withTimeout(
        exitPromise,
        EXIT_TIMEOUT_MS,
        `Active-agent handoff PTY did not exit. Output:\n${outputTail(output)}`
      )
      await waitForPidsToExit(trackedPids)
    } finally {
      if (!exited && !killIssued) {
        try {
          proc.kill()
          killIssued = true
        } catch {
          // The PTY may have exited between the state check and cleanup.
        }
      }
      if (!exited) {
        await withTimeout(
          exitPromise,
          EXIT_TIMEOUT_MS,
          'Failed to tear down active-agent handoff ConPTY'
        ).catch(() => undefined)
      }
      if (!exited) {
        for (const pid of [...trackedPids].toReversed()) {
          try {
            process.kill(pid)
          } catch {
            // Best-effort cleanup only after the ConPTY close path failed.
          }
        }
      }
    }
  })
})
