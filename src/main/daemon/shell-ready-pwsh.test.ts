// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { STARTUP_COMMAND_FEATURES } from '../shell-startup-launch-intent-fixtures'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput
} from '../shell-startup-output-scanner'
import { HeadlessEmulator } from './headless-emulator'
import { shellReadyMarkerComesFromLineEditor } from '../../shared/shell-ready-marker-timing'

const PWSH_CANDIDATES = ['pwsh', '/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh'] as const

function resolvePwshBinary(): string | null {
  if (process.platform === 'win32') {
    return null
  }
  for (const path of PWSH_CANDIDATES) {
    if (spawnSync(path, ['-NoProfile', '-Command', 'exit 0']).status === 0) {
      return path
    }
  }
  return null
}

const PWSH = resolvePwshBinary()
const itWithPwsh = PWSH ? it : it.skip

const SHELL_READY_MARKER_OUTPUT = '\x1b]777;orca-shell-ready\x07'

describe('daemon shell-ready launch config for pwsh', () => {
  it('extends the startup barrier to pwsh so launch commands queue until the prompt', async () => {
    vi.resetModules()
    const { shellPathSupportsPtyStartupBarrier } = await import('./shell-ready')

    expect(shellPathSupportsPtyStartupBarrier('/opt/homebrew/bin/pwsh')).toBe(true)
    // Why: a shell with no marker source must stay off the barrier or its first
    // command queues until the ready timeout.
    expect(shellPathSupportsPtyStartupBarrier('/usr/bin/tcsh')).toBe(false)
  })

  it('marks pwsh launch config ready and hands the bootstrap the feature allowlist', async () => {
    vi.resetModules()
    const { getShellLaunchConfig } = await import('./shell-ready')

    const config = getShellLaunchConfig('/opt/homebrew/bin/pwsh', STARTUP_COMMAND_FEATURES)

    expect(config.supportsReadyMarker).toBe(true)
    expect(config.env.ORCA_SHELL_FEATURES?.split(',')).toContain('ready')
    expect(config.args?.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])
  })

  it('keeps markerless pwsh panes byte-identical to the plain OSC 133 integration', async () => {
    vi.resetModules()
    const { getShellLaunchConfig } = await import('./shell-ready')

    const config = getShellLaunchConfig('/opt/homebrew/bin/pwsh', [])

    expect(config.supportsReadyMarker).toBe(false)
    expect(config.env).toEqual({})
  })

  it('treats the pwsh prompt function as a line-editor marker source', () => {
    // Why: the marker fires from the wrapped prompt, which the engine invokes
    // right before PSConsoleHostReadLine reads — the same moment bash/zsh precmd
    // fires, so the post-ready flush gate must treat it identically.
    expect(shellReadyMarkerComesFromLineEditor('/opt/homebrew/bin/pwsh')).toBe(
      process.platform !== 'win32'
    )
    expect(shellReadyMarkerComesFromLineEditor('/usr/bin/zsh')).toBe(true)
  })

  it('arms the barrier and the line-editor flush for the same PowerShell set', async () => {
    vi.resetModules()
    const { shellPathSupportsPtyStartupBarrier } = await import('./shell-ready')

    // Why: the barrier arms for every isPowerShellExecutableName match, so the
    // timing predicate must cover exactly that set — a name in one but not the
    // other holds stdin yet drops the prompt-owns-input delivery semantics.
    for (const name of ['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']) {
      const shellPath = `/opt/shells/${name}`
      expect(shellPathSupportsPtyStartupBarrier(shellPath)).toBe(process.platform !== 'win32')
      expect(shellReadyMarkerComesFromLineEditor(shellPath)).toBe(process.platform !== 'win32')
    }
  })

  itWithPwsh(
    'emits the marker at the first real pwsh prompt and executes a post-marker command',
    async () => {
      const { getShellLaunchConfig } = await import('./shell-ready')
      const config = getShellLaunchConfig(PWSH ?? 'pwsh', STARTUP_COMMAND_FEATURES)
      const tempHome = mkdtempSync(join(tmpdir(), 'pwsh-shell-ready-'))
      const sentinel = join(tempHome, 'launched')
      try {
        // Why: mimic the reporter's slow profile (oh-my-posh) so the command
        // injection would land inside pwsh's startup window without the barrier.
        const profileDir = join(tempHome, '.config', 'powershell')
        mkdirSync(profileDir, { recursive: true })
        // Why a slow profile: mimic the reporter's oh-my-posh warm start so the
        // command injection would land inside pwsh's startup window without the
        // barrier holding it.
        writeFileSync(
          join(profileDir, 'Microsoft.PowerShell_profile.ps1'),
          'Start-Sleep -Milliseconds 400\n'
        )
        const pty = await import('node-pty')
        const proc = pty.spawn(PWSH ?? 'pwsh', config.args ?? [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: tempHome,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: tempHome,
            TERM: 'xterm-256color',
            ...config.env
          }
        })
        let output = ''
        let scannedOutput = ''
        const startupScanState = createShellStartupOutputScanState()
        let commandWritten = false
        let settle = (): void => {}
        const done = new Promise<void>((resolve) => {
          settle = resolve
        })
        const deadline = setTimeout(settle, 15_000)
        // Why: pwsh's .NET console queries the cursor position during startup and
        // blocks on the reply; an unanswered query strands the prompt (and with it
        // the marker) for the whole ready timeout.
        const cursorReply = (): void => {
          proc.write('\x1b[1;1R')
        }
        proc.onData((chunk) => {
          output += chunk
          scannedOutput += scanShellStartupOutput(startupScanState, chunk).output
          if (chunk.includes('\x1b[6n')) {
            cursorReply()
          }
          if (!commandWritten && output.includes(SHELL_READY_MARKER_OUTPUT)) {
            commandWritten = true
            // Why: mirror PostReadyFlushGate — flush shortly after the marker draw.
            setTimeout(() => proc.write(`touch ${sentinel}\r`), 50)
          }
          if (commandWritten && existsSync(sentinel)) {
            settle()
          }
        })
        await done
        clearTimeout(deadline)
        proc.kill()
        scannedOutput += drainShellStartupOutputScanState(startupScanState)

        expect(output).toContain(SHELL_READY_MARKER_OUTPUT)
        expect(output.split(SHELL_READY_MARKER_OUTPUT)).toHaveLength(2)
        expect(scannedOutput).toBe(output.replace(SHELL_READY_MARKER_OUTPUT, ''))
        const rendered = new HeadlessEmulator({ cols: 80, rows: 24 })
        expect(rendered.writeSync(scannedOutput)).toBe(true)
        rendered.dispose()
        expect(existsSync(sentinel)).toBe(true)
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    },
    20_000
  )

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
