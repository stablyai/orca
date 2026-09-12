import { describe, expect, it } from 'vitest'
import { runHookScriptWithDeadline } from './hook-script-deadline'

// Real shells, real signals, real deadlines. The bug this file exists for (#19334) is invisible to
// a mocked `exec`: it lives in what the OS and the child actually do to each other.
const sh = (script: string, timeoutMs = 400) =>
  runHookScriptWithDeadline({
    script,
    cwd: process.cwd(),
    shell: '/bin/bash',
    env: process.env,
    timeoutMs
  })

describe.skipIf(process.platform === 'win32')('runHookScriptWithDeadline', () => {
  it('reports a clean run', async () => {
    await expect(sh('echo archived')).resolves.toMatchObject({ success: true, exitCode: 0 })
  })

  it('reports an observed non-zero exit', async () => {
    await expect(sh('echo boom >&2; exit 23')).resolves.toMatchObject({
      success: false,
      exitCode: 23
    })
  })

  it('reports a shell command-not-found as the observed 127 it is', async () => {
    const result = await sh('definitely-not-a-real-binary-xyz')
    expect(result).toMatchObject({ success: false, exitCode: 127 })
  })

  it('withholds the exit code when the hook is killed by a signal', async () => {
    const result = await sh('kill -KILL $$')
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
  })

  it('withholds the exit code when the hook fails to spawn', async () => {
    const result = await runHookScriptWithDeadline({
      script: 'echo hi',
      cwd: process.cwd(),
      shell: '/nonexistent/shell',
      env: process.env,
      timeoutMs: 400
    })
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
  })

  it('fails a hook that outruns its deadline', async () => {
    const result = await sh('sleep 30', 200)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
    expect(result.output).toContain('timed out')
  })

  // The regression this module was extracted for: Node's own `exec({ timeout })` only SIGTERMs,
  // so a hook that traps the signal and exits 0 came back as a PASS — a hook cut off mid-archive,
  // reported as one that finished. The verdict must come from the deadline, not the corpse.
  it('fails a timed-out hook that traps SIGTERM and exits zero', async () => {
    const result = await sh("trap 'exit 0' TERM; sleep 30", 200)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
    expect(result.output).toContain('timed out')
  })

  it('still terminates a hook that traps SIGTERM and refuses to die', async () => {
    const result = await sh("trap '' TERM; sleep 30", 200)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
  }, 15_000)
})
