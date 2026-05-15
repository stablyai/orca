const REMOTE_RUNTIME_CALL_CONCURRENCY = 8
const REMOTE_RUNTIME_BACKGROUND_CALL_CONCURRENCY = 2

type QueuedRuntimeCall<T> = {
  background: boolean
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type RuntimeCallQueue = {
  active: number
  backgroundActive: number
  foreground: QueuedRuntimeCall<unknown>[]
  background: QueuedRuntimeCall<unknown>[]
}

const runtimeCallQueues = new Map<string, RuntimeCallQueue>()

function isBackgroundRuntimeMethod(method: string): boolean {
  return (
    method === 'hostedReview.forBranch' ||
    method === 'github.listWorkItems' ||
    method === 'github.countWorkItems' ||
    method === 'git.status' ||
    method === 'git.conflictOperation' ||
    method === 'git.branchCompare' ||
    method === 'git.upstreamStatus'
  )
}

function getRuntimeCallQueue(selector: string): RuntimeCallQueue {
  let queue = runtimeCallQueues.get(selector)
  if (!queue) {
    queue = { active: 0, backgroundActive: 0, foreground: [], background: [] }
    runtimeCallQueues.set(selector, queue)
  }
  return queue
}

export function enqueueRuntimeCall<T>(
  selector: string,
  method: string,
  run: () => Promise<T>
): Promise<T> {
  const queue = getRuntimeCallQueue(selector)
  return new Promise<T>((resolve, reject) => {
    const call: QueuedRuntimeCall<T> = {
      background: isBackgroundRuntimeMethod(method),
      run,
      resolve,
      reject
    }
    const targetQueue = call.background ? queue.background : queue.foreground
    targetQueue.push(call as QueuedRuntimeCall<unknown>)
    pumpRuntimeCallQueue(selector, queue)
  })
}

function pumpRuntimeCallQueue(selector: string, queue: RuntimeCallQueue): void {
  while (queue.active < REMOTE_RUNTIME_CALL_CONCURRENCY) {
    let call = queue.foreground.shift()
    if (!call && queue.backgroundActive < REMOTE_RUNTIME_BACKGROUND_CALL_CONCURRENCY) {
      call = queue.background.shift()
    }
    if (!call) {
      break
    }

    queue.active += 1
    if (call.background) {
      queue.backgroundActive += 1
    }
    // Why: remote WebSocket servers have a finite connection budget and each
    // one-shot RPC currently opens its own encrypted socket. Background PR/task
    // refreshes must not stampede the server and starve terminal/worktree calls.
    void call
      .run()
      .then(call.resolve, call.reject)
      .finally(() => {
        queue.active = Math.max(0, queue.active - 1)
        if (call.background) {
          queue.backgroundActive = Math.max(0, queue.backgroundActive - 1)
        }
        if (queue.active === 0 && queue.foreground.length === 0 && queue.background.length === 0) {
          runtimeCallQueues.delete(selector)
          return
        }
        pumpRuntimeCallQueue(selector, queue)
      })
  }
}
