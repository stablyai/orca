import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { ORCAD_FENCE_LOST_EXIT, ORCAD_FENCE_LOST_MARKER } from './orcad-activation-fence-scope'
import { ORCAD_WINDOWS_HOST_SCRIPT } from './orcad-windows-host-script'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function hostWithFence(token: string) {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-win-fence-'))
  dirs.push(dir)
  const script = join(dir, 'host.js')
  writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
  const root = join(dir, '.orcad-activation-transaction')
  const lock = join(root, '.install-lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, '.orca-fence-owner'), token)
  const journal = join(root, 'transaction.json')
  writeFileSync(journal, JSON.stringify({ fenceToken: token }, null, 2))
  const op = (...args: string[]) =>
    runProcess({ program: process.execPath, args: [script, ...args], timeoutMs: 15_000 })
  return { lock, journal, op }
}

// The Windows host script enforces the same generation check as the POSIX guard.
describe('the Windows host script under an activation fence', () => {
  it('runs an op only for the fence’s current holder', async () => {
    const host = hostWithFence('successor')
    const stale = await host.op('--fence', host.lock, 'stale', 'fence-check')
    expect(stale.code).toBe(ORCAD_FENCE_LOST_EXIT)
    expect(stale.stdout).toContain(ORCAD_FENCE_LOST_MARKER)
    const owner = await host.op('--fence', host.lock, 'successor', 'fence-check')
    expect(owner).toMatchObject({ code: 0, stdout: 'OK' })
  })

  it('releases only its own generation, leaving a successor’s fence and journal', async () => {
    const host = hostWithFence('successor')
    expect((await host.op('fence-release', host.lock, host.journal, 'stale')).stdout).toBe(
      'SUPERSEDED'
    )
    expect(existsSync(host.lock)).toBe(true)
    expect(existsSync(host.journal)).toBe(true)
    expect((await host.op('fence-release', host.lock, host.journal, 'successor')).stdout).toBe(
      'RELEASED'
    )
    expect(existsSync(host.lock)).toBe(false)
    expect(existsSync(host.journal)).toBe(false)
  })

  // Astra pass 9, the Windows state-mutation race: a successor's restore must not run beside a
  // paused clear whose holder the script cannot identify.
  it('keeps a successor restore busy while a paused clear still holds the mutation lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-win-mutation-'))
    dirs.push(dir)
    const script = join(dir, 'host.js')
    writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
    const root = join(dir, 'root')
    const snapshot = join(dir, 'snapshot')
    mkdirSync(join(root, 'profiles'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'state.json'), 'snapshot-state')
    const fence = join(dir, '.orcad-activation-transaction', '.install-lock')
    mkdirSync(fence, { recursive: true })
    writeFileSync(join(fence, '.orca-fence-owner'), 'first-token')
    const fenced = (token: string, ...args: string[]) => [script, '--fence', fence, token, ...args]
    const capture = await runProcess({
      program: process.execPath,
      args: fenced('first-token', 'snapshot-capture', root, snapshot)
    })
    expect(capture.stdout.trim()).toBe('CAPTURED')
    const ready = join(dir, 'ready')
    const resume = join(dir, 'resume')
    const preload = join(dir, 'pause-rm.cjs')
    writeFileSync(
      preload,
      `const fs=require('fs'); const rm=fs.promises.rm; fs.promises.rm=async function(p,...a){ if(p===${JSON.stringify(join(root, 'profiles'))}){ fs.writeFileSync(${JSON.stringify(ready)},''); while(!fs.existsSync(${JSON.stringify(resume)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20) } return rm.call(this,p,...a) }`
    )
    const first = spawnProcess({
      program: process.execPath,
      args: ['--require', preload, ...fenced('first-token', 'snapshot-clear', root)]
    })
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true))
      utimesSync(join(dir, 'orcad-state-mutation.lock'), new Date(0), new Date(0))
      writeFileSync(join(fence, '.orca-fence-owner'), 'successor-token')
      const restore = await runProcess({
        program: process.execPath,
        args: fenced('successor-token', 'snapshot-restore', root, snapshot)
      })
      expect(restore.stdout.trim()).toBe('STATE_MUTATION_BUSY')
      expect(readFileSync(join(root, 'profiles', 'state.json'), 'utf8')).toBe('snapshot-state')
    } finally {
      writeFileSync(resume, '')
      first.kill('SIGKILL')
    }
  })
})

// BUG-23 on Windows: the host names the lock an exited predecessor left, never a live run's, and
// writes nothing, so the steal's own arbitration is the only thing that takes it (Astra 26087).
describe('the Windows host script proving a lock an exited client left', () => {
  function quietHost(owner: string) {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-win-exited-'))
    dirs.push(dir)
    const script = join(dir, 'host.js')
    writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
    const lock = join(dir, '.orcad-activation-transaction', '.install-lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, '.orca-fence-owner'), owner)
    const quietSince = new Date(Date.now() - 10 * 60_000)
    utimesSync(lock, quietSince, quietSince)
    const mutation = join(dir, 'orcad-state-mutation.lock')
    const check = async (guard: '0' | '1', ...tokens: string[]) => {
      const before = statSync(lock).mtimeMs
      const result = await runProcess({
        program: process.execPath,
        args: [script, 'fence-exited-owner', lock, guard, ...tokens],
        timeoutMs: 15_000
      })
      expect(statSync(lock).mtimeMs).toBe(before)
      return result.stdout.trim()
    }
    return { lock, mutation, check }
  }

  it('names a quiet lock an exited client holds, and nothing else', async () => {
    const host = quietHost('t-exited')
    expect(await host.check('0', 't-other')).toBe('KEPT')
    expect(await host.check('0', 't-other', 't-exited')).toBe('EXITED_OWNER t-exited')
  })

  it('keeps a lock that is not yet quiet', async () => {
    const host = quietHost('t-exited')
    utimesSync(host.lock, new Date(), new Date())
    expect(await host.check('0', 't-exited')).toBe('KEPT')
  })

  it('keeps the fence while its state mutation holder may still run', async () => {
    const host = quietHost('t-exited')
    mkdirSync(host.mutation)
    // A live pid whose creation time is unreadable is unverifiable, never exited.
    writeFileSync(
      join(host.mutation, 'owner.json'),
      JSON.stringify({ pid: process.pid, creationTimeMs: 1234 })
    )
    expect(await host.check('1', 't-exited')).toBe('KEPT')
    // The install lock guards no state mutation.
    expect(await host.check('0', 't-exited')).toBe('EXITED_OWNER t-exited')
  })

  // Astra 26087 r2: the steal can only hold an absent mutation lock across the takeover.
  it('keeps the fence while any mutation lock exists, even one whose holder exited', async () => {
    const host = quietHost('t-exited')
    mkdirSync(host.mutation)
    utimesSync(host.mutation, new Date(0), new Date(0))
    expect(await host.check('1', 't-exited')).toBe('KEPT')
    const exited = await runProcess({ program: process.execPath, args: ['-p', 'process.pid'] })
    writeFileSync(
      join(host.mutation, 'owner.json'),
      JSON.stringify({ pid: Number(exited.stdout.trim()), creationTimeMs: 1234 })
    )
    expect(await host.check('1', 't-exited')).toBe('KEPT')
    rmSync(host.mutation, { recursive: true })
    expect(await host.check('1', 't-exited')).toBe('EXITED_OWNER t-exited')
  })
})

// Astra 26087 r2: the exited-owner steal holds the mutation lock across the takeover, so a
// mutation that takes the lock afterwards must find its fence gone and stop before any work.
describe('a Windows state mutation admitted after its fence was replaced', () => {
  it('stops before touching state and frees the mutation lock', async () => {
    const host = hostWithFence('old-token')
    const dir = join(host.lock, '..', '..')
    const root = join(dir, 'root')
    mkdirSync(join(root, 'profiles'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'state.json'), 'kept')
    const preload = join(dir, 'steal-before-mutation-lock.cjs')
    // The fence check passes, then the fence is replaced right before the mutation lock is taken.
    writeFileSync(
      preload,
      `const fs = require('fs'); const mkdir = fs.mkdirSync;
fs.mkdirSync = function (p, ...rest) {
  if (String(p).endsWith('orcad-state-mutation.lock')) fs.writeFileSync(${JSON.stringify(join(host.lock, '.orca-fence-owner'))}, 'new-token')
  return mkdir.call(this, p, ...rest)
}`
    )
    const result = await runProcess({
      program: process.execPath,
      args: [
        '--require',
        preload,
        join(dir, 'host.js'),
        '--fence',
        host.lock,
        'old-token',
        'snapshot-clear',
        root
      ],
      timeoutMs: 15_000
    })
    expect(result.code).toBe(ORCAD_FENCE_LOST_EXIT)
    expect(result.stdout.trim()).toBe(ORCAD_FENCE_LOST_MARKER)
    expect(readFileSync(join(root, 'profiles', 'state.json'), 'utf8')).toBe('kept')
    expect(existsSync(join(dir, 'orcad-state-mutation.lock'))).toBe(false)
  })
})
