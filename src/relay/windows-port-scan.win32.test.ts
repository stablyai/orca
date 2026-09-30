import { describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import { windowsPowerShellPath } from '../shared/child-process/windows-system-binary'
import {
  WINDOWS_PORT_SCAN_SCRIPT,
  parseWindowsPowerShellPortRows,
  scanWindowsListeningPorts
} from './windows-port-scan'

/**
 * The mocked suite pins the argv; this pins that the argv works.
 *
 * Both halves are things a mock cannot see: netstat's real column layout (a
 * `-p tcp` here silently drops every `[::]` listener), and whether the joined
 * one-line PowerShell script even parses — a missing `;` between statements is
 * a ParserError, and the fallback would then be dead on the day it is needed.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('windows port scan against the real host', () => {
  it('finds listeners over both address families through netstat', async () => {
    const ports = await scanWindowsListeningPorts()

    expect(ports.length).toBeGreaterThan(0)
    for (const port of ports) {
      expect(port.port).toBeGreaterThan(0)
      expect(port.host.length).toBeGreaterThan(0)
    }
    // Windows binds RPC/SMB dual-stack, so both families must be represented.
    expect(ports.some((port) => port.host.includes(':'))).toBe(true)
    expect(ports.some((port) => !port.host.includes(':'))).toBe(true)
    // Names come from the shared process table, never from a shell of our own.
    expect(ports.some((port) => port.processName)).toBe(true)
    // The table spells them `svchost.exe`; clients have always seen `svchost`.
    expect(ports.every((port) => !port.processName?.endsWith('.exe'))).toBe(true)
  }, 30_000)

  it('runs the de-escalated PowerShell fallback command line', async () => {
    const result = await runProcess({
      program: windowsPowerShellPath(),
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PORT_SCAN_SCRIPT],
      timeoutMs: 20_000
    })

    // No stderr assertion: an autoload or first-run banner writes there without
    // the scan having failed.
    expect(result.code).toBe(0)
    expect(parseWindowsPowerShellPortRows(result.stdout).length).toBeGreaterThan(0)
  }, 30_000)
})
