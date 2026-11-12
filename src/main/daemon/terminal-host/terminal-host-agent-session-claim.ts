import { terminalStartError } from '../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import type { TerminalExitCause } from '../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type { TerminalCreationWork } from './terminal-creation-work'
import type { ClaimedAgentPtyOwnerRegistry } from '../../../shared/claimed-agent-pty-owner'
import type { PtyCreationDisposition } from '../../../shared/terminal/pty/lifecycle/pty-creation-disposition'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionOwnerBinding
} from '../../../shared/agent-session/agent-session-host-authority'
import type { SpawnIntent } from '../../../shared/terminal/pty/admission/spawn-admission-contract'
import type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

export type InternalCreateOrAttachOptions = CreateOrAttachOptions & {
  agentSessionGeneration?: string
  /** Request identity for the fork gate; absent for in-process callers. */
  spawnAdmission?: { clientId: string; declaredIntent: SpawnIntent | null; deadlineAt: number }
  creationWork?: TerminalCreationWork
  onCreationDisposition?: (disposition: PtyCreationDisposition) => void
  onPhysicalOwner?: (completion: Promise<void>, exitCode: () => number | null) => void
  isCanceled?: () => boolean
  cancelSignal?: AbortSignal
  /** The claim result an adopting attach already knows, so its own reply reports it. */
  agentSessionEnsured?: AgentSessionClaimedSpawnResult
}

function observeClaimedSessionExit(
  onExit: InternalCreateOrAttachOptions['streamClient']['onExit']
) {
  let observedExit: { incarnationId: string; cause?: TerminalExitCause } | undefined
  return {
    get exit() {
      return observedExit
    },
    onExit: (code: number, incarnationId: string, cause?: TerminalExitCause): void => {
      observedExit = { incarnationId, cause }
      onExit(code, incarnationId, cause)
    }
  }
}

export async function createOrAttachClaimedAgentSession(args: {
  options: InternalCreateOrAttachOptions
  owners: ClaimedAgentPtyOwnerRegistry
  isLive: (owner: AgentSessionOwnerBinding) => boolean
  createOrAttach: (options: InternalCreateOrAttachOptions) => Promise<CreateOrAttachResult>
}): Promise<CreateOrAttachResult> {
  const ensureRequest = args.options.agentSessionEnsure
  if (!ensureRequest) {
    return await args.createOrAttach(args.options)
  }
  let created: CreateOrAttachResult | null = null
  const observed = observeClaimedSessionExit(args.options.streamClient.onExit)
  const ensured = await args.owners.ensure({
    exitedDuringStart: () =>
      terminalStartError(
        'agent_session_exited_during_start',
        created?.isNew && created.incarnationId === observed.exit?.incarnationId
          ? observed.exit.cause
          : undefined,
        created?.incarnationId
      ),
    creation: args.options.creationWork?.completion,
    onJoin: (creation) => {
      if (creation) {
        args.options.creationWork?.join(creation)
      } else {
        args.options.creationWork?.dispatched()
      }
    },
    claim: ensureRequest.claim,
    surface: ensureRequest.surface,
    spawn: async ({ generation }) => {
      created = await args.createOrAttach({
        ...args.options,
        agentSessionGeneration: generation,
        streamClient: {
          ...args.options.streamClient,
          onExit: observed.onExit
        }
      })
      return { ptyId: args.options.sessionId }
    },
    isLive: args.isLive
  })
  if (ensured.disposition === 'created' && created) {
    return { ...(created as CreateOrAttachResult), agentSessionEnsure: ensured }
  }
  const adopted = await args.createOrAttach({
    ...args.options,
    sessionId: ensured.owner.ptyId,
    command: undefined,
    agentSessionEnsure: undefined,
    agentSessionEnsured: ensured,
    attachOnly: true
  })
  return { ...adopted, agentSessionEnsure: ensured }
}
