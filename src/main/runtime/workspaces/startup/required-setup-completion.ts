import { setupStartFailure } from '../../../../shared/agent-launch/startup/setup-start-failure'
import type { RuntimeLocalWorktreeTerminalPorts } from './runtime-local-worktree-terminal-startup'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import { DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'

type SetupCompletionHost = {
  waitForSetupTerminalCompletion: (
    handle: string,
    signal?: AbortSignal
  ) => Promise<{ exitCode: number | null }>
}

export async function waitForRequiredSetup(
  host: SetupCompletionHost,
  receipt: { startupPolicy: string; state: string; terminalHandle?: string } | undefined,
  agent: string
): Promise<void> {
  if (
    !receipt ||
    receipt.startupPolicy !== 'wait-for-setup' ||
    receipt.state === 'skipped' ||
    receipt.state === 'not_configured' ||
    receipt.state === 'succeeded' ||
    receipt.state === 'not_applicable'
  ) {
    return
  }
  const failure = () => new Error(setupStartFailure(agent))
  if (receipt.state !== 'running' || !receipt.terminalHandle) {
    throw failure()
  }
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const completion = await Promise.race([
      host.waitForSetupTerminalCompletion(receipt.terminalHandle, abort.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure()), DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000)
      })
    ])
    if (completion.exitCode !== 0) {
      throw failure()
    }
  } catch {
    throw failure()
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

export function deliverWorktreeInputAfterSetup(args: {
  ports: Pick<
    RuntimeLocalWorktreeTerminalPorts,
    'waitForSetupTerminalCompletion' | 'pasteDraft' | 'sendFollowup'
  >
  terminal: RuntimeTerminalCreate
  setupTerminalHandle: string | null
  didSpawnSetup: boolean
  draftPaste?: WorktreeStartupDraftPaste
  startupFollowup?: WorktreeStartupFollowup
  agent: string
}): void {
  void waitForRequiredSetup(
    args.ports,
    {
      startupPolicy: 'wait-for-setup',
      state: args.didSpawnSetup ? 'running' : 'spawn_failed',
      ...(args.setupTerminalHandle ? { terminalHandle: args.setupTerminalHandle } : {})
    },
    args.agent
  )
    .then(() => {
      if (args.draftPaste) {
        args.ports.pasteDraft(args.terminal.handle, args.draftPaste)
      }
      if (args.startupFollowup) {
        args.ports.sendFollowup(args.terminal.handle, args.startupFollowup, args.terminal)
      }
    })
    .catch((error: unknown) =>
      console.warn(
        '[worktree-create]',
        error instanceof Error ? error.message : 'Setup did not finish successfully.'
      )
    )
}
