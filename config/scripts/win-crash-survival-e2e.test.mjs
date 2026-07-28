import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../tools/win-crash-survival-e2e/cli-args.mjs'
import { buildCrashAssertions } from '../../tools/win-crash-survival-e2e/crash-assertions.mjs'
import { scanPwshFailFast } from '../../tools/win-crash-survival-e2e/crash-step.mjs'
import { selectScopedDaemon } from '../../tools/win-crash-survival-e2e/daemon-identity.mjs'
import {
  reattachSentinelMatches,
  selectCreatedTabId
} from '../../tools/win-crash-survival-e2e/reattach-proof.mjs'
import { quotePowerShellLiteral } from '../../tools/win-update-e2e/powershell-runner.mjs'
import { closeApp, resolveElectronMainPid } from '../../tools/win-update-e2e/app-driver.mjs'
import { isPidAlive } from '../../tools/win-update-e2e/daemon-processes.mjs'

describe('win-crash-survival-e2e proof contracts', () => {
  it('keeps the packaged proof wired as a targeted pull-request gate', () => {
    const workflow = readFileSync('.github/workflows/win-crash-survival-e2e.yml', 'utf8')
    expect(workflow).toMatch(/^  pull_request:/m)
    expect(workflow).not.toMatch(/^  push:/m)
    expect(workflow).toContain("- 'src/main/daemon/**'")
    expect(workflow).toContain("- 'src/main/index.ts'")
    expect(workflow).toContain("- 'src/main/ipc/pty*.ts'")
    expect(workflow).toContain("- 'src/main/startup/first-window-startup-services.ts'")
    expect(workflow).toContain("- 'src/main/window/attach-main-window-services.ts'")
    expect(workflow).toContain("- 'src/preload/**'")
    expect(workflow).toContain("- 'src/renderer/src/components/terminal-pane/**'")
    expect(workflow).toContain("- 'src/renderer/src/store/slices/terminals.ts'")
    expect(workflow).toContain("- '!src/**/*.test.*'")
    expect(workflow).toContain("- '!src/**/*.bench.*'")
    expect(workflow).toContain('--expect "$env:EXPECT"')
    expect(workflow).toContain('exit $LASTEXITCODE')
    expect(workflow).toContain("'!config/**/*.test.*'")
    expect(workflow).toContain("'!src/**/*.test.*'")
    expect(workflow).toContain("'!src/**/*.bench.*'")
    expect(workflow).toContain("'!config/reliability-gates.jsonc'")
    expect(workflow).toContain("'resources/**'")
    expect(workflow).toContain('cache: pnpm')
    expect(workflow.indexOf('- name: Setup Node.js')).toBeGreaterThan(
      workflow.indexOf('- name: Setup pnpm')
    )
    expect(workflow).toContain("if: steps.cache-installer.outputs.cache-hit != 'true'")
    expect(workflow).toContain('crash-survival-electron-builder-')
  })

  it('requires the full survival oracle, including daemon identity and reattach', () => {
    const base = {
      profile: 'survival',
      mainDied: true,
      daemonAliveAfterCrash: true,
      shellAliveAfterCrash: true,
      failFastEvents: [],
      preDaemonPid: 101,
      postDaemonPid: 101,
      postDaemonAlive: true,
      reattachProven: true
    }
    expect(buildCrashAssertions(base).every((entry) => entry.pass)).toBe(true)
    expect(
      buildCrashAssertions({ ...base, postDaemonPid: 202 }).find((entry) =>
        entry.name.startsWith('relaunch adopts')
      )?.pass
    ).toBe(false)
    expect(
      buildCrashAssertions({ ...base, reattachProven: false }).find((entry) =>
        entry.name.startsWith('reattached UI')
      )?.pass
    ).toBe(false)
  })

  it('scans for FailFast only after the post-crash input probe', () => {
    const harness = readFileSync('tools/win-crash-survival-e2e/run.mjs', 'utf8')
    const scanIndex = harness.indexOf('const { events: failFastEvents }')
    const probeIndex = harness.indexOf('reattachProven = await proveReattachedShell')
    expect(scanIndex).not.toBe(-1)
    expect(probeIndex).not.toBe(-1)
    expect(scanIndex).toBeGreaterThan(probeIndex)
  })

  it('fails closed when the Windows event log query fails', () => {
    let command = ''
    expect(() =>
      scanPwshFailFast(1234, (received) => {
        command = received
        return { code: 1, stdout: '', stderr: 'access denied', error: null }
      })
    ).toThrow('pwsh-failfast scan failed (exit 1): access denied')
    expect(command).toContain('-ErrorAction Stop')
    expect(command).toContain('NoMatchingEventsFound*')
  })

  it('accepts an empty event result only from the serialized evidence envelope', () => {
    expect(
      scanPwshFailFast(1234, () => ({
        code: 0,
        stdout: '{"events":[]}',
        stderr: '',
        error: null
      }))
    ).toEqual({ events: [] })
    expect(() =>
      scanPwshFailFast(1234, () => ({ code: 0, stdout: '', stderr: '', error: null }))
    ).toThrow('pwsh-failfast scan returned no JSON output')
    expect(() =>
      scanPwshFailFast(1234, () => ({ code: 0, stdout: '{}', stderr: '', error: null }))
    ).toThrow('without an events envelope')
  })

  it('fails closed when PID liveness evidence is unavailable', () => {
    expect(isPidAlive(42, () => ({ code: 0, stdout: 'alive\n', stderr: '', error: null }))).toBe(
      true
    )
    expect(isPidAlive(42, () => ({ code: 0, stdout: 'dead\n', stderr: '', error: null }))).toBe(
      false
    )
    expect(() =>
      isPidAlive(42, () => ({ code: 1, stdout: '', stderr: 'access denied', error: null }))
    ).toThrow('PID liveness probe failed (exit 1): access denied')
    expect(() => isPidAlive(42, () => ({ code: 0, stdout: '', stderr: '', error: null }))).toThrow(
      'PID liveness probe returned an invalid state'
    )
  })

  it('uses the scoped live process as daemon authority', () => {
    expect(
      selectScopedDaemon(
        [{ pid: 42, appVersion: '1.2.3' }],
        [{ pid: 42, commandLine: 'daemon-entry.js --socket scoped' }]
      )
    ).toEqual({ pid: 42, appVersion: '1.2.3' })
    expect(() =>
      selectScopedDaemon(
        [{ pid: 41, appVersion: 'stale' }],
        [{ pid: 42, commandLine: 'daemon-entry.js --socket scoped' }]
      )
    ).toThrow('daemon PID file does not match scoped live daemon 42')
    expect(() => selectScopedDaemon([], [])).toThrow('expected exactly one')
    expect(() => selectScopedDaemon([], [{ pid: 1 }, { pid: 2 }])).toThrow('expected exactly one')
  })

  it('rejects CLI typos and duplicate value flags before launching', () => {
    const baseArgs = ['--expect', 'survival', '--exe-path', process.execPath]
    expect(parseArgs(baseArgs).errors).toEqual([])
    expect(parseArgs([...baseArgs, '--exe-pathh', process.execPath]).errors).toContain(
      'Unknown argument: --exe-pathh'
    )
    expect(parseArgs([...baseArgs, '--expect', 'orphaned']).errors).toContain(
      'Duplicate argument: --expect'
    )
  })

  it('quotes apostrophes in generated PowerShell path literals', () => {
    expect(quotePowerShellLiteral("C:\\Users\\O'Brien\\shell.pid")).toBe(
      "'C:\\Users\\O''Brien\\shell.pid'"
    )
  })

  it('targets exactly the terminal tab created before the crash', () => {
    expect(selectCreatedTabId(['agent-tab'], ['agent-tab', 'terminal-tab'])).toBe('terminal-tab')
    expect(() => selectCreatedTabId(['agent-tab'], ['agent-tab'])).toThrow(
      'expected exactly one created terminal tab, found 0'
    )
    expect(() => selectCreatedTabId([], ['first', 'second'])).toThrow(
      'expected exactly one created terminal tab, found 2'
    )
  })

  it('requires both the per-shell canary and exact survivor pid', () => {
    expect(reattachSentinelMatches('1660|canary\r\n', 'canary', 1660)).toBe(true)
    expect(reattachSentinelMatches('1770|canary', 'canary', 1660)).toBe(false)
    expect(reattachSentinelMatches('1660|other', 'canary', 1660)).toBe(false)
    expect(reattachSentinelMatches('1660|canary|extra', 'canary', 1660)).toBe(false)
  })

  it('requires the real packaged main for the crash proof but permits fallback cleanup', async () => {
    const harness = readFileSync('tools/win-crash-survival-e2e/run.mjs', 'utf8')
    expect(harness).toContain(
      'resolveElectronMainPid(session.app, { allowLauncherFallback: false })'
    )
    expect(
      await resolveElectronMainPid({
        evaluate: async () => 222,
        process: () => ({ pid: 111 })
      })
    ).toBe(222)
    const unavailableApp = {
      evaluate: async () => {
        throw new Error('main unavailable')
      },
      process: () => ({ pid: 111 })
    }
    expect(
      await resolveElectronMainPid(unavailableApp, { allowLauncherFallback: false })
    ).toBeNull()
    expect(await resolveElectronMainPid(unavailableApp)).toBe(111)
  })

  it('bounds main PID resolution when the Electron connection is wedged', async () => {
    vi.useFakeTimers()
    try {
      const result = resolveElectronMainPid(
        {
          evaluate: () => new Promise(() => {}),
          process: () => ({ pid: 333 })
        },
        { timeoutMs: 20 }
      )
      await vi.advanceTimersByTimeAsync(20)
      await expect(result).resolves.toBe(333)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the close deadline after a successful app close', async () => {
    vi.useFakeTimers()
    try {
      await closeApp({
        evaluate: async () => 444,
        process: () => ({ pid: 333 }),
        close: async () => {}
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
