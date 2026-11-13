import type { QueuedCloudPrompt } from './cloud-prompt-queue'
import type { CloudLaunchedAgent } from './cloud-workspace-host-operations'

/** What one delivery pass over a workspace's waiting prompts ended in. */
export type CloudDeliveryOutcome =
  | { kind: 'open' }
  | { kind: 'launched'; worktreeId: string; agent: CloudLaunchedAgent }
  /** A prompt didn't start. `open`: the user asked to open the workspace, so it opens anyway. */
  | { kind: 'failed'; code: string | null; open: boolean }

export type CloudDeliveryDeps = {
  listQueued: (sandboxId: string) => Promise<QueuedCloudPrompt[]>
  ensureWorktree: () => Promise<string>
  launch: (worktreeId: string, prompt: QueuedCloudPrompt) => Promise<CloudLaunchedAgent>
  deliverQueued: (
    sandboxId: string,
    deliver: (prompt: QueuedCloudPrompt) => Promise<void>,
    errorCodeFor: (error: unknown) => string
  ) => Promise<{ delivered: number; failed: QueuedCloudPrompt[] }>
  markWaitingFailed: (sandboxId: string, code: string) => Promise<void>
  errorCodeFor: (error: unknown) => string
}

const waiting = (queue: QueuedCloudPrompt[]) => queue.some((prompt) => prompt.status !== 'failed')

/**
 * Sends a workspace's waiting prompts once its host is connected. A prompt that can't start is
 * marked failed (shown with Retry and Remove) rather than left waiting, so it never stands between
 * the user and the workspace: "Open workspace" opens it whatever the prompts did.
 */
export async function runCloudDelivery(
  sandboxId: string,
  intent: 'open' | 'send',
  deps: CloudDeliveryDeps
): Promise<CloudDeliveryOutcome> {
  if (!waiting(await deps.listQueued(sandboxId))) {
    return { kind: 'open' }
  }
  const launches: CloudLaunchedAgent[] = []
  let worktreeId: string
  let failed = 0
  try {
    worktreeId = await deps.ensureWorktree()
    // Prompts typed while this ran are picked up too, so none is left "waiting" behind it.
    for (let round = 0; round < 5; round++) {
      const next = await deps.deliverQueued(
        sandboxId,
        async (prompt) => {
          launches.push(await deps.launch(worktreeId, prompt))
        },
        deps.errorCodeFor
      )
      failed += next.failed.length
      if (next.delivered + next.failed.length === 0 || !waiting(await deps.listQueued(sandboxId))) {
        break
      }
    }
  } catch (error) {
    // Nothing was launched (the project or connection failed first): every waiting prompt says why
    // instead of "Waiting to connect", and Open no longer tries to send them again.
    const code = deps.errorCodeFor(error)
    await deps.markWaitingFailed(sandboxId, code).catch(() => undefined)
    return { kind: 'failed', code, open: intent === 'open' }
  }
  if (failed > 0) {
    return { kind: 'failed', code: null, open: intent === 'open' }
  }
  const last = launches[launches.length - 1]
  return last ? { kind: 'launched', worktreeId, agent: last } : { kind: 'open' }
}
