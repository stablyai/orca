// MEMGUARD: the VM's memory guard (image/vm/orca-memguard) ranks processes for the kernel's OOM killer
// so Orca's runtime and terminals outlive a build that eats the VM's memory, and names the process it
// would stop. Run against a fake process table (ORCA_MEMGUARD_PROC); the kill itself is verified in a VM.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const GUARD = fileURLToPath(new URL('../image/vm/orca-memguard', import.meta.url).href)
const START = fileURLToPath(new URL('../image/vm/orca-sandbox-start', import.meta.url).href)
// mapfile -d needs bash 4.4+ (the VM has 5.x; macOS's /bin/bash is 3.2).
const bash = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/usr/bin/bash', '/bin/bash'].find(
  (path) => spawnSync(path, ['-c', '[ "${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}" -ge 44 ]']).status === 0
)

const NODE = '/opt/orca/runtime/runtimes/node-abc/bin/node'
let proc = ''

function fake(pid: number, opts: { ppid: number; adj: number; rssPages: number; argv: string[]; comm?: string }): void {
  const dir = join(proc, String(pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cmdline'), opts.argv.length ? `${opts.argv.join('\0')}\0` : '')
  writeFileSync(join(dir, 'comm'), `${opts.comm ?? 'x'}\n`)
  writeFileSync(join(dir, 'stat'), `${pid} (${opts.comm ?? 'x'}) S ${opts.ppid} ${pid} ${pid} 0 -1\n`)
  writeFileSync(join(dir, 'statm'), `${opts.rssPages * 2} ${opts.rssPages} 100 1 0 1 0\n`)
  writeFileSync(join(dir, 'oom_score_adj'), `${opts.adj}\n`)
}
const adj = (pid: number): number => Number(readFileSync(join(proc, String(pid), 'oom_score_adj'), 'utf8').trim())
const guard = (command: string) => spawnSync(bash!, [GUARD, command], { env: { PATH: process.env.PATH, ORCA_MEMGUARD_PROC: proc }, encoding: 'utf8' })

beforeEach(() => {
  proc = mkdtempSync(join(tmpdir(), 'orca-memguard-proc-'))
  fake(1, { ppid: 0, adj: 500, rssPages: 3000, argv: ['/run/vercel/share/sandbox-init'] })
  fake(100, { ppid: 1, adj: 500, rssPages: 2_000_000, argv: [NODE, '/opt/orca/bin/orcad-boot', '--code-cache'], comm: 'MainThread' })
  fake(101, { ppid: 100, adj: 500, rssPages: 20_000, argv: [NODE, '--max-semi-space-size=4', '/opt/orca/runtime/orcad/daemon-entry.js'] })
  // A terminal's shell, and a typecheck it started (inherited the shell's rank).
  fake(102, { ppid: 101, adj: 500, rssPages: 1_000, argv: ['/bin/bash', '-l'], comm: 'bash' })
  fake(103, { ppid: 102, adj: -500, rssPages: 900_000, argv: ['node', '--max-old-space-size=8192', '/w/node_modules/typescript/bin/tsc', '-p', '.'], comm: 'MainThread' })
  fake(104, { ppid: 102, adj: 300, rssPages: 40_000, argv: ['/opt/google/chrome/chrome', '--type=renderer'], comm: 'chrome' })
  fake(105, { ppid: 102, adj: 800, rssPages: 40_000, argv: ['/usr/bin/some-tool'] })
  fake(106, { ppid: 1, adj: -1000, rssPages: 600, argv: ['sshd: /opt/orca/openssh/sshd'] })
  fake(107, { ppid: 102, adj: 500, rssPages: 400_000, argv: ['/opt/orca/tools/bin/claude'], comm: 'claude' })
  fake(108, { ppid: 2, adj: 0, rssPages: 0, argv: [] }) // a kernel thread
})
afterEach(() => rmSync(proc, { recursive: true, force: true }))

describe.skipIf(!bash)('orca-memguard', () => {
  it('protects the runtime, terminals and agents, and makes everything else the first victim', () => {
    expect(guard('sweep').status).toBe(0)
    expect([100, 101].map(adj)).toEqual([-900, -900])
    expect(adj(102)).toBe(-500) // the terminal's shell
    expect(adj(107)).toBe(-500) // an agent CLI
    expect(adj(103)).toBe(500) // the shell's typecheck no longer inherits its rank
    expect(adj(104)).toBe(500)
    expect(adj(105)).toBe(800) // a process that raised its own rank keeps it
    expect(adj(106)).toBe(-1000) // what root pinned stays pinned
    expect(adj(108)).toBe(0) // kernel threads are not touched
    expect(adj(1)).toBe(500)
  })

  it('would stop the largest unprotected process and names it by its script', () => {
    const result = guard('victim')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(`103 ${900_000 * 4} tsc`)
  })

  it('names inline code by its interpreter, and leaves small processes to the kernel', () => {
    fake(103, { ppid: 102, adj: 500, rssPages: 900_000, argv: ['node', '-e', 'const secret = 1'], comm: 'MainThread' })
    expect(guard('victim').stdout.trim()).toBe(`103 ${900_000 * 4} node`)
    rmSync(join(proc, '103'), { recursive: true })
    rmSync(join(proc, '104'), { recursive: true })
    rmSync(join(proc, '105'), { recursive: true })
    // Only protected memory is large: nothing worth stopping.
    expect(guard('victim').status).toBe(1)
  })

  it('starts from orca-sandbox-start before its already-running exit', () => {
    const start = readFileSync(START, 'utf8')
    const launch = start.indexOf('orca-memguard" start')
    expect(launch).toBeGreaterThan(0)
    expect(launch).toBeLessThan(start.indexOf('print_ready\n  exit 0'))
  })
})
