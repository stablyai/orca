/** The structured agent-session methods (and chat attachment uploads) a phone may call; spread into the execution-host routes. */
export const MOBILE_AGENT_SESSION_RPC_METHODS = [
  'agentSession.createSupport',
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.reveal',
  'agentSession.send',
  'agentSession.cancel',
  'agentSession.queuedMessageSend',
  'agentSession.queuedMessageDelete',
  'agentSession.queuedMessageUpdate',
  'agentSession.queuedMessageEditHold',
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
  'agentSession.currentRequests',
  'agentSession.subscribe',
  'agentSession.unsubscribe',
  // Every session's status on one stream: the phone's chat reads the host's "Stopping…" from it.
  'agentSession.subscribeStatus',
  // One visual from the chat's own scratch folder, for the transcript's `::orca-visual` lines.
  'agentSession.readVisual',
  // One item whole, for "Show full output" and "Show full message".
  'agentSession.item',
  // A file the phone attaches to a chat, stored on this host; the agent sees only the host path.
  'agentSessionAttachment.uploadStart',
  'agentSessionAttachment.uploadAppend',
  'agentSessionAttachment.uploadCommit',
  'agentSessionAttachment.uploadAbort',
  // Stored images back as previews when the phone has no copy of its own.
  'agentSessionAttachment.read',
  // No-ops on a current host; kept until MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION passes the
  // mobile builds that still call them.
  'agentSession.hold',
  'agentSession.release'
] as const
