import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'
import * as nativeSpawn from '@orca/process-host/native-process-spawn'
import { execFileCapture } from './exec-file-capture'

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('owned child did not finish')), 12_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')`
afterEach(() => vi.restoreAllMocks())

describe.skipIf(process.platform === 'win32')('real owned POSIX capture', () => {
  it.each(['abort', 'overflow', 'timeout'] as const)(
    'retires a TERM-ignoring descendant on %s',
    async (reason) => {
      const rootFirst = reason !== 'overflow'
      const script = `
      const {spawn}=require('node:child_process');
      const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{
        stdio:['ignore',${rootFirst ? "'inherit','inherit'" : "'ignore','ignore'"},'ipc']
      });
      descendant.on('message',()=>{
        process.stderr.write(JSON.stringify({pid:descendant.pid})+'\\n',()=>{
          ${rootFirst ? 'process.exit(0)' : "process.stdout.write('x'.repeat(128))"}
        });
      });
      setInterval(()=>{},1000);
    `
      const unrelated = spawnProcess({
        program: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        stdio: 'ignore'
      })
      let root: ChildProcess | undefined
      const original = nativeSpawn.spawnNativeProcess
      vi.spyOn(nativeSpawn, 'spawnNativeProcess').mockImplementation((...args) => {
        const child = original(...args)
        root ??= child
        return child
      })
      const controller = new AbortController()
      let ready!: (pid: number) => void
      const readyPid = new Promise<number>((resolve) => {
        ready = resolve
      })
      let report!: () => void
      const physical = new Promise<void>((resolve) => {
        report = resolve
      })
      const terminated = vi.fn(report)
      let stderr = ''
      const pending = execFileCapture(process.execPath, ['-e', script], {
        ownedPosixGroup: true,
        signal: controller.signal,
        timeout: reason === 'timeout' ? 3_000 : 10_000,
        maxBuffer: 64,
        onChildTerminated: terminated,
        onStderr: (chunk) => {
          stderr += chunk
          const line = stderr.split('\n')[0]
          if (stderr.includes('\n')) {
            ready(JSON.parse(line).pid)
          }
        }
      }).catch((error: unknown) => error)
      let verified = false
      let descendantPid: number | undefined
      try {
        const pid = await bounded(readyPid)
        descendantPid = pid
        if (rootFirst && root?.exitCode === null) {
          await bounded(once(root, 'exit'))
        }
        if (reason === 'abort') {
          controller.abort()
        }
        const outcome = await bounded(pending)
        expect(outcome).toMatchObject(
          reason === 'abort'
            ? { name: 'AbortError' }
            : reason === 'overflow'
              ? { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'x'.repeat(64) }
              : { message: `${process.execPath} timed out.` }
        )
        await bounded(physical)
        const state = await runProcess({ program: 'ps', args: ['-o', 'stat=', '-p', String(pid)] })
        expect(state.stdout.trim() === '' || state.stdout.trim().startsWith('Z')).toBe(true)
        verified = true
        expect(terminated).toHaveBeenCalledOnce()
        expect(process.kill(unrelated.pid!, 0)).toBe(true)
      } finally {
        controller.abort()
        if (!verified) {
          root?.kill('SIGKILL')
          if (descendantPid) {
            try {
              process.kill(descendantPid, 'SIGKILL')
            } catch {
              /* fixture descendant exited */
            }
          }
        }
        const closed = once(unrelated, 'close')
        unrelated.kill('SIGKILL')
        await closed
        await pending
      }
    }
  )

  it('preserves a redirected hook daemon at ordinary successful close', async () => {
    let pid: number | undefined
    try {
      const terminated = vi.fn()
      const result = await execFileCapture(
        process.execPath,
        [
          '-e',
          `
        const child=require('node:child_process').spawn(process.execPath,['-e',
          "setInterval(()=>{},1000);process.send('ready')"
        ],{stdio:['ignore','ignore','ignore','ipc']});
        child.on('message',()=>process.stdout.write(String(child.pid),()=>process.exit(0)));
      `
        ],
        { ownedPosixGroup: true, timeout: 5_000, onChildTerminated: terminated }
      )
      pid = Number(result.stdout.toString())
      expect(process.kill(pid, 0)).toBe(true)
      expect(terminated).toHaveBeenCalledOnce()
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* fixture daemon exited */
        }
      }
    }
  })

  it('preserves bytes, requested encoding, stdin and a throwing passive observer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const observer = vi.fn(() => {
      throw new Error('observer failed')
    })
    await expect(
      execFileCapture(
        process.execPath,
        [
          '-e',
          `
      const chunks=[];process.stdin.on('data',c=>chunks.push(c));
      process.stdin.on('end',()=>{
        process.stdout.write(Buffer.concat(chunks));
        process.stdout.write(Buffer.from([0,255,128]));
        process.stderr.write(Buffer.from([255,0]));process.exitCode=7;
      });
    `
        ],
        {
          ownedPosixGroup: true,
          encoding: null,
          stdin: 'input',
          onStderr: observer,
          timeout: 5_000
        }
      )
    ).rejects.toMatchObject({
      code: 7,
      stdout: Buffer.from([105, 110, 112, 117, 116, 0, 255, 128]),
      stderr: Buffer.from([255, 0])
    })
    expect(observer).toHaveBeenCalledOnce()
    await expect(
      execFileCapture(process.execPath, ['-e', 'process.stdout.write(Buffer.from([255,128]))'], {
        ownedPosixGroup: true,
        encoding: 'latin1',
        maxBuffer: 2,
        timeout: 5_000
      })
    ).resolves.toEqual({ stdout: 'ÿ\u0080', stderr: '' })
  })
})
