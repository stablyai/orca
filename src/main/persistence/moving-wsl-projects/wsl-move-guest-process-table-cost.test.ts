import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyWslGuestPaneForeground,
  parseWslGuestPaneProcesses,
  WSL_GUEST_PANE_PROCESS_SCRIPT
} from './wsl-move-guest-foreground'

const itOnPosix = process.platform === 'win32' ? it.skip : it
const TOOLS = ['cat', 'tr', 'sed', 'head', 'wc', 'readlink', 'grep']

let root: string | undefined
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
  root = undefined
})

/** A fake /proc: a pane shell and its untagged job among `others` processes; returns tool calls. */
function runAgainst(others: number): { calls: number; stdout: string } {
  root = mkdtempSync(join(tmpdir(), 'orca-guest-table-'))
  const proc = join(root, 'proc')
  const entry = (pid: number, comm: string, ppid: number, sid: number, environ: string) => {
    const dir = join(proc, String(pid))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${sid} ${sid} 0\n`)
    writeFileSync(join(dir, 'environ'), environ)
    writeFileSync(join(dir, 'cmdline'), `${comm}\0`)
    symlinkSync('/home/a', join(dir, 'cwd'))
  }
  entry(100, 'bash', 1, 100, 'ORCA_PANE_KEY=tab:leaf\0')
  // Started with `env -i`: no pane key, but in the pane shell's session.
  entry(200, 'sleep', 100, 100, 'PATH=/bin\0')
  for (let pid = 1000; pid < 1000 + others; pid += 1) {
    entry(pid, 'other', 1, pid, 'PATH=/bin\0')
  }
  // Each tool is shimmed to log its call, then run the real one.
  const bin = join(root, 'bin')
  const log = join(root, 'calls')
  mkdirSync(bin)
  writeFileSync(log, '')
  for (const tool of TOOLS) {
    const real = execFileSync('sh', ['-c', `command -v ${tool}`])
      .toString()
      .trim()
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> '${log}'\nexec '${real}' "$@"\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  const script = WSL_GUEST_PANE_PROCESS_SCRIPT.replaceAll('/proc/', `${proc}/`)
  const stdout = execFileSync('sh', ['-c', script], {
    env: { PATH: `${bin}:${process.env.PATH ?? ''}` }
  }).toString()
  const calls = execFileSync('cat', [log]).toString().split('\n').filter(Boolean).length
  return { calls, stdout }
}

describe("the move's guest process table", () => {
  // Review of #33398: one fork storm per /proc entry made busy distros hit the read's cap.
  itOnPosix(
    'costs the same however many processes the distro runs, and keeps untagged jobs',
    () => {
      const few = runAgainst(5)
      const many = runAgainst(400)
      expect(many.calls).toBe(few.calls)
      const rows = parseWslGuestPaneProcesses(many.stdout) ?? []
      expect(rows).toHaveLength(402)
      expect(classifyWslGuestPaneForeground(rows, 'tab:leaf')).toBe('process-running')
    }
  )
})
