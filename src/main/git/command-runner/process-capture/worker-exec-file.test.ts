import { once } from 'node:events'
import { runProcess } from '@orca/process-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeWorktree } from '../../worktrees/removal/worktree-removal'
import { prepareWorktreeRemovalsForStore } from '../../../workspaces/removal/worktree-removal-records-load'
import {
  startBackgroundWorktreeRemoval,
  _resetPendingWorktreeRemovalsForTests
} from '../../../workspaces/removal/worktree-background-removal'
import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import { readWorktreeRemovalRecords } from '../../../workspaces/removal/worktree-removal-records'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildModule from '../../../worker-thread-child-process/worker-thread-child-process'
import type {
  WorkerThreadChildProcess,
  WorkerThreadChildProcessHost
} from '../../../worker-thread-child-process/worker-thread-child-process'
import { createWorkerThreadChildProcessTestEntry } from '../../../worker-thread-child-process/worker-thread-child-process-worker.test-fixtures'
import { capturesOnWorker, workerExecFile } from './worker-exec-file'
import { execFileCapture } from './exec-file-capture'

const state = vi.hoisted(() => {
  const state: { host: WorkerThreadChildProcessHost | null } = { host: null }
  return state
})
vi.mock('../../../worker-thread-child-process/worker-thread-child-process', async (original) => ({
  ...(await original<typeof WorkerChildModule>()),
  whenSpawnWorkerReady: async () => state.host !== null,
  spawnWorkerReadyNow: () => state.host !== null,
  spawnProcessOnWorkerThread: (spec: Parameters<WorkerThreadChildProcessHost['spawn']>[0]) => {
    if (!state.host) {
      throw new Error('Test worker not initialized')
    }
    return state.host.spawn(spec)
  }
}))

let entryPath = ''
let disposeEntry: (() => Promise<void>) | undefined
const workers: Worker[] = []

beforeAll(async () => {
  const entry = await createWorkerThreadChildProcessTestEntry()
  entryPath = entry.entryPath
  disposeEntry = entry.dispose
})
afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.terminate()))
  await disposeEntry?.()
})

async function createHost(gate?: SharedArrayBuffer) {
  const { WorkerThreadChildProcessHost } =
    await import('../../../worker-thread-child-process/worker-thread-child-process')
  state.host = new WorkerThreadChildProcessHost(() => {
    // Hold this worker synchronously before process creation; the UI loop must still turn.
    const worker = gate
      ? new Worker(
          `const {workerData}=require('node:worker_threads');Atomics.wait(new Int32Array(workerData),0,0);require(${JSON.stringify(entryPath)})`,
          { eval: true, workerData: gate }
        )
      : new Worker(entryPath)
    workers.push(worker)
    return worker
  })
}

// A launch reaches the worker after its ready check; watch for it before starting one, then wait before stopping.
function nextWorkerLaunch(): Promise<WorkerThreadChildProcess> {
  const host = state.host!
  const spawn = host.spawn.bind(host)
  const launched = Promise.withResolvers<WorkerThreadChildProcess>()
  vi.spyOn(host, 'spawn').mockImplementationOnce((spec) => {
    const child = spawn(spec)
    launched.resolve(child)
    return child
  })
  return launched.promise
}

function capture(script: string, maxBuffer = 1024 * 1024) {
  let child: ReturnType<typeof workerExecFile> | undefined
  const result = new Promise<{
    error: Error | null
    stdout: string | Buffer
    stderr: string | Buffer
  }>((resolve) => {
    child = workerExecFile(
      process.execPath,
      ['-e', script],
      { maxBuffer },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    )
  })
  if (!child) {
    throw new Error('Worker child was not created')
  }
  return { child, result }
}

describe('worker-owned Git capture', () => {
  it('preserves UTF-8, stdin, stderr and nonzero exit status', async () => {
    await createHost()
    const pending = capture(
      'process.stdin.setEncoding("utf8");process.stdin.on("data",data=>process.stdout.write(data));process.stdin.on("end",()=>{process.stderr.write("missing remote ref");process.exitCode=128})'
    )
    pending.child.stdin.write('orca 🐋')
    pending.child.stdin.end()
    await expect(pending.result).resolves.toMatchObject({
      stdout: 'orca 🐋',
      stderr: 'missing remote ref',
      error: { code: 128 }
    })
  })

  it('rejects overflowing output and bounds retained bytes', async () => {
    await createHost()
    const pending = capture('process.stdout.write("x".repeat(4096))', 32)
    await expect(pending.result).resolves.toMatchObject({
      stdout: 'x'.repeat(32),
      error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }
    })
  })

  it('reports a missing executable without a successful empty result', async () => {
    await createHost()
    const result = new Promise<Error | null>((resolve) =>
      workerExecFile('/orca/nonexistent-git', [], { maxBuffer: 32 }, (error) => resolve(error))
    )
    // Callers classify a missing binary by its spawn syscall (isMissingCommandBinaryError).
    await expect(result).resolves.toMatchObject({
      code: 'ENOENT',
      syscall: 'spawn /orca/nonexistent-git'
    })
  })
})

describe.skipIf(process.platform === 'win32')('POSIX captured Git on the worker', () => {
  it("keeps main's failure text and passes the caller's current environment", async () => {
    await createHost()
    const proxy = vi.spyOn(state.host!, 'spawn')
    const script = 'printf "$ORCA_WORKER_ENV_PROBE" >&2; exit 3'
    const failure = execFileCapture('sh', ['-c', script], {
      ownedPosixGroup: true,
      encoding: 'utf8',
      env: { ...process.env, ORCA_WORKER_ENV_PROBE: 'fatal: from current env' }
    }).catch((error: unknown) => error)
    await expect(failure).resolves.toMatchObject({
      code: 3,
      message:
        process.platform === 'darwin'
          ? 'fatal: from current env'
          : `Command failed: sh -c ${script}\nfatal: from current env`,
      stderr: 'fatal: from current env'
    })
    expect(proxy).toHaveBeenCalledOnce()
    proxy.mockRestore()
  })

  it('starts a launch with a start gate on main, where the gate is checked at creation', async () => {
    await createHost()
    const proxy = vi.spyOn(state.host!, 'spawn')
    const { stdout } = await execFileCapture('sh', ['-c', 'printf gated'], {
      ownedPosixGroup: true,
      encoding: 'utf8',
      canStart: () => true
    })
    expect(stdout).toBe('gated')
    expect(proxy).not.toHaveBeenCalled()
    proxy.mockRestore()
  })

  it.skipIf(process.platform === 'win32')(
    'starts a guarded checkout delete on the worker even with a start gate, or not at all',
    async () => {
      await createHost()
      const identity = {
        instanceId: 'A',
        root: '/checkout',
        rootKey: 'root',
        markerKey: 'marker',
        gitDir: '/repo/.git/worktrees/checkout',
        adminKey: 'admin',
        nonce: 'nonce'
      }
      const worktreeCheckoutGuard = { identity }
      const gated = { canStart: () => true, worktreeCheckoutGuard }
      expect(await capturesOnWorker('git', { ...gated, spawnOnWorkerThread: true })).toBe(true)
      // Without the worker, exec-file-capture refuses it as unverifiable instead of running it on main.
      expect(await capturesOnWorker('git', gated)).toBe(false)
    }
  )

  it('returns output far past the worker high-water mark intact', async () => {
    await createHost()
    const { stdout } = await execFileCapture(
      process.execPath,
      ['-e', 'process.stdout.write("ab".repeat(4 * 1024 * 1024))'],
      { ownedPosixGroup: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
    expect(stdout).toBe('ab'.repeat(4 * 1024 * 1024))
  })

  it('keeps each of many concurrent launches on its own output', async () => {
    await createHost()
    const results = await Promise.all(
      Array.from({ length: 48 }, (_, index) =>
        execFileCapture('sh', ['-c', `printf ${index}`], {
          ownedPosixGroup: true,
          encoding: 'utf8'
        })
      )
    )
    expect(results.map((result) => result.stdout)).toEqual(
      Array.from({ length: 48 }, (_, index) => String(index))
    )
  })

  it("ends a lost worker's running group from main before a fenced child reports its end", async () => {
    await createHost()
    const lost = vi.fn()
    const terminated = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<number>()
    let diagnostic = ''
    const pending = execFileCapture('sh', ['-c', 'sleep 60 & echo $! >&2; wait'], {
      ownedPosixGroup: true,
      encoding: 'utf8',
      onWorkerLost: lost,
      onChildTerminated: terminated.resolve,
      onStderr: (chunk) => {
        diagnostic += chunk
        if (diagnostic.includes('\n')) {
          ready.resolve(Number(diagnostic.trim()))
        }
      }
    }).catch((error: unknown) => error)
    const descendant = await ready.promise
    let verified = false
    try {
      await workers.at(-1)?.terminate()
      await expect(pending).resolves.toMatchObject({ code: 'ERR_ORCA_WORKER_CHILD_ABANDONED' })
      expect(lost).toHaveBeenCalledOnce()
      await terminated.promise
      const left = await runProcess({
        program: 'ps',
        args: ['-o', 'stat=', '-p', String(descendant)]
      })
      expect(left.stdout.trim() === '' || left.stdout.trim().startsWith('Z')).toBe(true)
      verified = true
    } finally {
      if (!verified) {
        try {
          process.kill(descendant, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
  })
})

describe.skipIf(process.platform === 'win32')('POSIX worker capture cancellation', () => {
  it('retires the worker-owned group after its root exited with inherited pipes still open', async () => {
    await createHost()
    const proxy = vi.spyOn(state.host!, 'spawn')
    const controller = new AbortController()
    const ready = Promise.withResolvers<number>()
    const physical = Promise.withResolvers<void>()
    let diagnostic = ''
    const pending = execFileCapture(
      process.execPath,
      [
        '-e',
        `
      const child=require('node:child_process').spawn(process.execPath,['-e',
        "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"
      ],{stdio:['ignore','inherit','inherit','ipc']});
      child.on('message',()=>process.stderr.write(String(child.pid)+'\\n',()=>process.exit(0)));
      setInterval(()=>{},1000);
    `
      ],
      {
        ownedPosixGroup: true,
        signal: controller.signal,
        timeout: 10_000,
        onChildTerminated: physical.resolve,
        onStderr: (chunk) => {
          diagnostic += chunk
          if (diagnostic.includes('\n')) {
            ready.resolve(Number(diagnostic.trim()))
          }
        }
      }
    ).catch((error: unknown) => error)
    let verified = false
    let descendant: number | undefined
    try {
      descendant = await ready.promise
      const child = proxy.mock.results[0]?.value
      if (!child) {
        throw new Error('worker did not return its child')
      }
      if (child.exitCode === null) {
        await once(child, 'exit')
      }
      controller.abort()
      await expect(pending).resolves.toMatchObject({ name: 'AbortError' })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          physical.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('worker group did not retire')), 12_000)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      const state = await runProcess({
        program: 'ps',
        args: ['-o', 'stat=', '-p', String(descendant)]
      })
      expect(state.stdout.trim() === '' || state.stdout.trim().startsWith('Z')).toBe(true)
      verified = true
    } finally {
      controller.abort()
      // Regression cleanup owns this exact descendant even if the old root-only stop leaked it.
      if (!verified && descendant) {
        try {
          process.kill(descendant, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
      proxy.mockRestore()
      await pending
    }
  })

  it('withdraws a queued launch it stops, reporting it terminated only once the worker drops it', async () => {
    const gate = new SharedArrayBuffer(4)
    await createHost(gate)
    const launched = nextWorkerLaunch()
    const controller = new AbortController()
    const terminated = vi.fn()
    const pending = execFileCapture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      ownedPosixGroup: true,
      signal: controller.signal,
      onChildTerminated: terminated
    })
    const outcome = pending.catch((error: unknown) => error)
    const child = await launched
    controller.abort()
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
    expect(terminated).not.toHaveBeenCalled()
    Atomics.store(new Int32Array(gate), 0, 1)
    Atomics.notify(new Int32Array(gate), 0)
    await vi.waitFor(() => expect(terminated).toHaveBeenCalledOnce())
    // Never created: no process existed to start the aborted command.
    expect(child.pid).toBeUndefined()
  })

  it('keeps removal ownership and durable intent until an aborted worker child is actually terminated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-removal-worker-close-'))
    const gate = new SharedArrayBuffer(4)
    await createHost(gate)
    const launched = nextWorkerLaunch()
    await prepareWorktreeRemovalsForStore({
      getProfileStorageDirectory: () => directory,
      getRepos: () => [{ id: 'repo' }]
    })
    const childStarted = Promise.withResolvers<void>()
    let closing: Promise<void> | undefined
    try {
      const result = startBackgroundWorktreeRemoval({
        removal: {
          worktreeId: 'repo::feature',
          repoId: 'repo',
          repoPath: directory,
          worktree: { path: join(directory, 'missing-checkout'), branch: 'feature', head: 'abc' },
          force: false,
          deleteBranch: false
        },
        publish: () => {},
        run: (signal) =>
          removeWorktree(directory, join(directory, 'missing-checkout'), false, {
            knownRemovedWorktree: { branch: 'feature', head: 'abc' },
            deleteBranch: false,
            checkoutDeleteSignal: signal,
            observeChildTermination: () => {
              childStarted.resolve()
            }
          })
      })
      void result.catch(() => {})
      await childStarted.promise
      await launched
      let closed = false
      closing = worktreeRemovalLifetime.close().then(() => {
        closed = true
      })
      await nextTurn()
      expect(closed).toBe(false)
      expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)
      Atomics.store(new Int32Array(gate), 0, 1)
      Atomics.notify(new Int32Array(gate), 0)
      await closing
      expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1)
      Atomics.notify(new Int32Array(gate), 0)
      await closing
      _resetPendingWorktreeRemovalsForTests()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports a launch as never started when its worker is lost before it could run anything', async () => {
    const gate = new SharedArrayBuffer(4)
    await createHost(gate)
    const launched = nextWorkerLaunch()
    const terminated = vi.fn()
    const pending = execFileCapture(process.execPath, ['-e', ''], {
      ownedPosixGroup: true,
      onChildTerminated: terminated
    })
    const outcome = pending.catch((error: unknown) => error)
    await launched
    await workers.at(-1)?.terminate()
    await expect(outcome).resolves.toBeInstanceOf(Error)
    expect(terminated).toHaveBeenCalledOnce()
  })
})
