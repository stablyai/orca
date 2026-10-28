import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseWslGuestPaneProcesses,
  WSL_GUEST_PANE_PROCESS_SCRIPT
} from './wsl-guest-pane-processes'

const itOnPosix = process.platform === 'win32' ? it.skip : it
const TOOLS = ['cat', 'tr', 'sed', 'head', 'readlink', 'grep']

let root: string | undefined
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
  root = undefined
})

/** A fake /proc with two pane processes among `others` untagged ones; returns the tool calls. */
function runAgainst(others: number): { calls: number; stdout: string } {
  root = mkdtempSync(join(tmpdir(), 'orca-guest-proc-'))
  const proc = join(root, 'proc')
  const entry = (pid: number, environ: string, comm?: string, cwd?: string) => {
    const dir = join(proc, String(pid))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'environ'), environ)
    if (comm && cwd) {
      writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S 1 ${pid} ${pid} 0`)
      writeFileSync(join(dir, 'comm'), `${comm}\n`)
      symlinkSync(cwd, join(dir, 'cwd'))
    }
  }
  entry(10, 'HOME=/h\0ORCA_PANE_KEY=tab:leaf\0', 'bash', '/home/a/deep')
  entry(11, 'ORCA_PANE_KEY=tab:leaf\0', 'sleep', '/tmp')
  for (let pid = 1000; pid < 1000 + others; pid += 1) {
    entry(pid, 'HOME=/h\0PATH=/bin\0')
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

describe('the guest pane process script', () => {
  // Review of #33398: one script fork storm per /proc entry made every WSL Sleep 0.5–2 s slower.
  itOnPosix('costs the same however many other processes the distro runs', () => {
    const few = runAgainst(5)
    const many = runAgainst(400)
    expect(many.calls).toBe(few.calls)
    expect(parseWslGuestPaneProcesses(many.stdout)).toEqual([
      { pid: 10, ppid: 1, comm: 'bash', paneKey: 'tab:leaf', cwd: '/home/a/deep' },
      { pid: 11, ppid: 1, comm: 'sleep', paneKey: 'tab:leaf', cwd: '/tmp' }
    ])
  })
})
