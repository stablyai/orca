import type { TerminalCreationWork } from './terminal-creation-work'
import type {
  ClaimedAgentPtyOwnerRegistry,
  PtyCreationDisposition
} from '../../shared/claimed-agent-pty-owner'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
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
  const ensured = await args.owners.ensure({
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
        agentSessionGeneration: generation
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
    attachOnly: true
  })
  return { ...adopted, agentSessionEnsure: ensured }
}
