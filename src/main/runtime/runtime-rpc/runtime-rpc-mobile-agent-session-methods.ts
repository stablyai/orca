/** The structured agent-session methods a phone may call; spread into the mobile allowlist. */
export const MOBILE_AGENT_SESSION_RPC_METHODS = [
  'agentSession.createSupport',
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.reveal',
  'agentSession.send',
  'agentSession.cancel',
  'agentSession.queuedMessageSend',
  'agentSession.queuedMessageDelete',
  'agentSession.queuedMessagesResume',
  'agentSession.close',
  'agentSession.respondToApproval',
  'agentSession.respondToQuestion',
  'agentSession.setOption',
  'agentSession.handoffStatus',
  'agentSession.options',
  'agentSession.modelCatalog',
  'agentSession.conversationCommand',
  'agentSession.commands',
  'agentSession.history',
  'agentSession.subscribe',
  'agentSession.unsubscribe',
  // Every session's status on one stream: the phone's chat reads the host's "Stopping…" from it.
  'agentSession.subscribeStatus',
  // One visual from the chat's own visuals folder, for the transcript's `::orca-visual` lines.
  'agentSession.readVisual',
  // No-ops on a current host; kept until MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION passes the
  // mobile builds that still call them.
  'agentSession.hold',
  'agentSession.release'
] as const
