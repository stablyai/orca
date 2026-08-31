import { randomUUID } from 'node:crypto'
import type {
  RuntimeTerminalClose,
  RuntimeTerminalCreate
} from '../../../shared/runtime-terminal-contracts'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { resolveCoordinatorTerminalHandle } from '../orchestration/terminal-identity'

export type MissionCoordinator = { handle: string; owned: boolean; ptyId?: string }

export async function acquireMissionCoordinator(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  worktree: string
): Promise<MissionCoordinator> {
  if (getOptionalStringFlag(flags, 'from') || process.env.ORCA_TERMINAL_HANDLE) {
    return { handle: await resolveCoordinatorTerminalHandle(flags, cwd, client), owned: false }
  }
  if (process.env.ORCA_PANE_KEY) {
    const resolved = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
      paneKey: process.env.ORCA_PANE_KEY
    })
    return { handle: resolved.result.terminal.handle, owned: false }
  }

  // Why: window focus is not the identity of an external shell's Mission.
  const clientMutationId = randomUUID()
  try {
    const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
      worktree,
      clientMutationId,
      title: `Mission coordinator ${clientMutationId}`,
      focus: false,
      presentation: 'background'
    })
    const handle = created.result.terminal.handle
    console.error(`Mission coordinator: ${handle}`)
    return { handle, owned: true, ptyId: created.result.terminal.ptyId ?? undefined }
  } catch (error) {
    console.error(
      `Mission coordinator creation was not confirmed (request ${clientMutationId}); inspect terminals before retrying.`
    )
    throw error
  }
}

export async function finishMissionCoordinator(
  client: RuntimeClient,
  coordinator: MissionCoordinator,
  mayHaveUnsettledRun: boolean
): Promise<void> {
  if (!coordinator.owned) {
    return
  }
  if (mayHaveUnsettledRun) {
    console.error(
      `Mission outcome unresolved; coordinator ${coordinator.handle} was not closed. Inspect the Run before retrying.`
    )
    return
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const closed = await client.call<{ close: RuntimeTerminalClose }>('terminal.close', {
        terminal: coordinator.handle
      })
      if (closed.result.close.ptyKilled && !closed.result.close.ptyStopVerdict) {
        return
      }
      if (attempt !== 0 || closed.result.close.ptyStopVerdict === 'live' || !coordinator.ptyId) {
        break
      }
      // Why: a young Windows shell can outlive the first stop deadline; the
      // first receipt may omit its verdict. Await exit, then revalidate before
      // one more close. A wait timeout is not itself evidence of process exit.
      try {
        await client.call('terminal.wait', {
          terminal: coordinator.handle,
          for: 'exit',
          timeoutMs: 5_000
        })
      } catch (error) {
        // Why: the server's condition timeout differs from a lost RPC reply.
        if (!(error instanceof RuntimeClientError) || error.code !== 'timeout') {
          throw error
        }
      }
      const shown = await client.call<{ terminal: { handle: string; ptyId?: string } }>(
        'terminal.show',
        {
          terminal: coordinator.handle
        }
      )
      if (
        shown.result.terminal.handle !== coordinator.handle ||
        shown.result.terminal.ptyId !== coordinator.ptyId
      ) {
        break
      }
    }
  } catch {
    // Why: cleanup failure must not replace the original Mission error.
  }
  process.exitCode = 1
  console.error(
    `Mission coordinator ${coordinator.handle} cleanup is unverifiable; inspect it before retrying closure.`
  )
}
