import type { FolderWorkspaceAgentLaunchOutcome } from '../../../../shared/folder-workspaces/folder-workspace-create'

/** Only observed success releases an agent that elected to wait; a timeout leaves Setup running. */
export async function groupSetupAgentOutcome(args: {
  required: boolean
  prepared: boolean
  terminalHandle?: string | null
  wait: (handle: string, signal: AbortSignal) => Promise<{ exitCode: number | null }>
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<FolderWorkspaceAgentLaunchOutcome> {
  if (!args.required) {
    return { status: 'not-required' }
  }
  if (!args.prepared) {
    return { status: 'failed', reason: 'preparation' }
  }
  if (!args.terminalHandle) {
    return { status: 'failed', reason: 'spawn' }
  }
  const terminalHandle = args.terminalHandle
  const observation = new AbortController()
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: FolderWorkspaceAgentLaunchOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      args.signal?.removeEventListener('abort', cancel)
      observation.abort()
      resolve(outcome)
    }
    const cancel = (): void => finish({ status: 'failed', reason: 'cancelled' })
    const deadline = setTimeout(
      () => finish({ status: 'failed', reason: 'timeout' }),
      args.timeoutMs ?? 60_000
    )
    if (args.signal?.aborted) {
      cancel()
      return
    }
    args.signal?.addEventListener('abort', cancel, { once: true })
    void Promise.resolve()
      .then(() => args.wait(terminalHandle, observation.signal))
      .then(
        ({ exitCode }) =>
          finish(exitCode === 0 ? { status: 'successful' } : { status: 'failed', reason: 'exit' }),
        () => finish({ status: 'failed', reason: 'observation' })
      )
  })
}
