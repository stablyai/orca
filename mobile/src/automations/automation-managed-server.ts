import { parseExecutionHostId } from '../../../src/shared/execution-host'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { AutomationDraft } from './automation-draft'
import {
  AutomationDraftValidationError,
  AutomationProjectNotOnServerError
} from './automation-error'
import {
  automationSetupKey,
  loadAutomationTargets,
  workspaceMatchesSetup,
  type AutomationTargets
} from './automation-target-inventory'

/** This desktop's servers, and how the screen moves a create on to one of them. */
export type AutomationServerHandoff = {
  servers: readonly MobileRelayHost[] | null
  /** The draft the server's new-automation editor opens on. */
  draft?: AutomationDraft
  continueOn: (server: MobileRelayHost, draft: AutomationDraft) => void
}

/** A managed SSH host keeps its automations on its Orca server (#24863), so a create for it belongs there. */
function automationManagedServer(
  draft: AutomationDraft,
  targets: AutomationTargets,
  servers: readonly MobileRelayHost[] | null | undefined
): MobileRelayHost | null {
  const setup = targets.setups.find((entry) => automationSetupKey(entry) === draft.setupId)
  const host = parseExecutionHostId(setup?.hostId)
  return host?.kind === 'ssh'
    ? (servers?.find((server) => server.managedSshTargetId === host.targetId) ?? null)
    : null
}

/** The same draft on the server's own setup of the project; a desktop-only project has to move first. */
async function automationServerDraft(
  client: RpcClient,
  server: MobileRelayHost,
  draft: AutomationDraft,
  targets: AutomationTargets
): Promise<AutomationDraft> {
  if (server.relay !== 'ready') {
    throw new AutomationDraftValidationError('destination')
  }
  const repoId = targets.setups.find((entry) => automationSetupKey(entry) === draft.setupId)?.repoId
  const onServer = await loadAutomationTargets(scopeRpcClientToExecutionHost(client, server.hostId))
  const setup = onServer.setups.find((entry) => entry.repoId === repoId)
  if (!setup) {
    throw new AutomationProjectNotOnServerError(server.label)
  }
  const workspace = onServer.workspaces.find(
    (entry) => entry.worktreeId === draft.workspaceId && workspaceMatchesSetup(entry, setup)
  )
  return { ...draft, setupId: automationSetupKey(setup), workspaceId: workspace?.worktreeId ?? '' }
}

/** Continue a managed SSH host's create on its server's editor; false when it stays here. */
export async function handOffToManagedServer(
  handoff: AutomationServerHandoff,
  client: RpcClient,
  draft: AutomationDraft,
  targets: AutomationTargets,
  current: () => boolean
): Promise<boolean> {
  const server = automationManagedServer(draft, targets, handoff.servers)
  if (!server) {
    return false
  }
  const serverDraft = await automationServerDraft(client, server, draft, targets)
  if (current()) {
    handoff.continueOn(server, serverDraft)
  }
  return true
}
