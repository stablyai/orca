// Per-worktree ordering shared by every chat's checkpoint work in this process. Process-local by
// design: the host that captures a chat's turns is the one that restores them (one main process
// or orcad per machine owns a chat).

// One git writer per worktree at a time across every chat in this process: a capture never
// interleaves with a restore, so a send after a rewind snapshots the restored files.
const queues = new Map<string, Promise<unknown>>()
export function serialize<T>(root: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(root) ?? Promise.resolve()).then(task, task)
  const tail = run.catch(() => undefined)
  queues.set(root, tail)
  void tail.then(() => queues.get(root) === tail && queues.delete(root))
  return run
}

// Worktrees with a turn between its snapshot and its hand-off to the agent: the chat isn't
// "working" yet, but a restore now would rewrite files the agent is about to see.
export const startingTurns = new Map<string, number>()
export function markTurnStarting(root: string): () => void {
  startingTurns.set(root, (startingTurns.get(root) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const left = (startingTurns.get(root) ?? 1) - 1
    if (left > 0) {
      startingTurns.set(root, left)
    } else {
      startingTurns.delete(root)
    }
  }
}
