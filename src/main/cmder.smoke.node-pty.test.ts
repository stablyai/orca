import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { applyCmderSpawnEnvironment, resolveCmderRoot } from './cmder'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'

// Real ConPTY launch against a locally installed Cmder; skipped when none is found.
describe.runIf(process.platform === 'win32' && resolveCmderRoot() !== null)('Cmder launch', () => {
  it('runs init.bat and keeps the requested cwd', async () => {
    const root = resolveCmderRoot()!
    const cwd = process.cwd()
    const launch = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      cwd,
      cwd,
      undefined,
      // Why `call`: /K expands %VAR% before init.bat runs; `call` re-expands afterwards.
      'call echo MARK[%^CMDER_ROOT%][%^CMDER_CONFIGURED%][%^CD%]',
      undefined,
      true
    )
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'CMDER_ROOT') {
        env[key] = value
      }
    }
    applyCmderSpawnEnvironment(env, root)
    const proc = pty.spawn('cmd.exe', launch.shellArgs, {
      cwd: launch.effectiveCwd,
      env,
      cols: 200,
      rows: 40
    })
    let out = ''
    proc.onData((data) => {
      out += data
    })
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
    const deadline = Date.now() + 30_000
    while (!out.includes('MARK[C:') && !out.includes(`MARK[${root}`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    proc.write('exit\r')
    await exited
    expect(out).toContain(`MARK[${root}][1][${cwd}]`)
  }, 60_000)
})
