import { SpikeRpcClient } from './SpikeRpcClient';

// mobile/src/transport/mobile-runtime-client-capabilities.ts at upstream 10c01509.
const CLIENT_CAPABILITIES: string[] = [
  "agent-session.background-task-stop.v1",
  "agent-session.background-task-row-stop.v1",
  "agent-session.background-task-child-views.v1",
  "agent-session.turn-item.v1",
  "session-tabs.close-intent.v1",
  "session-tabs.authoritative-inventory.v1",
  "agent-session.session-boundary.v1",
  "skills.install-result.v2",
  "worktree.github-pr-suppression.v1",
  "worktree.visibility-defaults.v1",
  "worktree.visibility-source-defaults.v1",
  "automation.owner-fencing.v1",
  "repo.search-qualified-refs.v1",
  "terminal.quick-commands.long-prompts.v1",
  "terminal.quick-commands.large-lists.v1",
  "transport.compressed-frames.v1",
  "agent-session.commands-on-request.v1",
  "agent-session.coherent-model-catalog.v1",
  "agent-session.structured.v1",
  "agent-session.current-requests.v1",
  "agent-session.pending-send-result.v1",
  "agent-session.structured.hold.v1",
  "agent-session.structured.claude.v1",
  "agent-session.structured.registered-agents.v1",
  "agent-session.structured.pi-dialogs.v1",
  "agent-session.options.optional-model.v1",
  "session-tabs.split-group-placement.v1",
  "agent.launch.v2",
  "agent.launch.unstarted-tab.v1",
  "agent.launch.tab-closed.v1",
  "agent-status.restored-unconfirmed.v1",
  "agentSession.create.message.v1",
  "agent-session.queued-image-cards.v1"
];

export async function settleRuntimeCapabilities(client: SpikeRpcClient): Promise<void> {
  let params: Record<string, string[]> = { 'clientCapabilities': CLIENT_CAPABILITIES };
  await client.request('runtime.clientCapabilities.update', JSON.stringify(params), 3000);
  if (client.getState() !== 'ready') { throw new Error('Capability advisory could not be sent'); }
}
