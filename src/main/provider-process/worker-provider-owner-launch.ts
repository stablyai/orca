import type { ChildProcess } from 'node:child_process'
import type { DeferredProviderOwner } from './deferred-provider-owner'
import { ProviderOwnerListener } from './provider-owner-channels'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import {
  spawnProviderOwnerOnWorkerThread,
  spawnWorkerReadyNow,
  whenSpawnWorkerReady
} from '../worker-thread-child-process/worker-thread-child-process'

const WORKER_READY_WAIT_MS = 500

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error('Worker provider launch timed out'))
  }
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker provider launch timed out')), timeoutMs)
    })
  ]).finally(() => {
    clearTimeout(timer)
  })
}

function workerOwnerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function launchOnMain(owner: DeferredProviderOwner, spawnHere: () => ChildProcess): void {
  let child: ChildProcess
  try {
    child = spawnHere()
  } catch (error) {
    owner.fail(error instanceof Error ? error : new Error(String(error)))
    return
  }
  if (child.pid === undefined) {
    child.once('error', (error) => owner.fail(error))
    return
  }
  owner.attach(child.pid, new Map(child.stdio.map((stream, fd) => [fd, stream])))
}

/** Spawns the native provider owner on the POSIX child-process worker so posix_spawn stays off main.
 * Falls back to `spawnHere` on main if the worker is not ready or fails before owner attach. */
export async function launchProviderOwnerOnWorker(
  owner: DeferredProviderOwner,
  spec: ProviderSpawnSpec,
  spawnHere: () => ChildProcess,
  timeoutMs: number
): Promise<void> {
  if (owner.canceled) {
    owner.fail(new Error('Provider launch canceled'))
    return
  }
  if (process.platform === 'win32' || timeoutMs <= 0) {
    launchOnMain(owner, spawnHere)
    return
  }
  const deadline = performance.now() + timeoutMs
  const remainingMs = (): number => Math.max(0, deadline - performance.now())
  if (!spawnWorkerReadyNow()) {
    const ready = await withDeadline(
      whenSpawnWorkerReady(),
      Math.min(WORKER_READY_WAIT_MS, remainingMs())
    ).catch(() => false)
    if (owner.canceled) {
      owner.fail(new Error('Provider launch canceled'))
      return
    }
    if (!ready || remainingMs() === 0) {
      launchOnMain(owner, spawnHere)
      return
    }
  }
  const listener = new ProviderOwnerListener()
  let attached = false
  try {
    const path = await listener.listen()
    if (owner.canceled) {
      throw new Error('Provider launch canceled')
    }
    const { pid } = await withDeadline(
      spawnProviderOwnerOnWorkerThread({
        nonce: listener.nonce,
        path,
        program: spec.program,
        args: spec.args,
        cwd: spec.cwd,
        env: workerOwnerEnv(spec.env)
      }),
      remainingMs()
    )
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error('Worker provider launch returned no process')
    }
    const pipes = await withDeadline(listener.ready, remainingMs())
    attached = true
    owner.attach(pid, pipes)
  } catch (error) {
    void listener.ready.then(
      (pipes) => pipes.forEach((pipe) => pipe.destroy()),
      () => {}
    )
    await listener.close()
    if (attached || owner.canceled) {
      owner.fail(error instanceof Error ? error : new Error('Provider could not start'))
    } else {
      launchOnMain(owner, spawnHere)
    }
  }
}
