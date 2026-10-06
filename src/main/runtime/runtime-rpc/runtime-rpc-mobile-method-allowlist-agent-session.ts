// The agentSession.* share of the mobile RPC allowlist. Split out of
// runtime-rpc-mobile-method-allowlist.ts so neither file grows past the .ts max-lines cap that
// config/scripts/check-max-lines-ratchet.mjs freezes; the two are one list at dispatch time.

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
  // No-ops on a current host; kept until MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION passes the
  // mobile builds that still call them.
  'agentSession.hold',
  'agentSession.release'
] as const
