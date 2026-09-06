import type { MobileWebSessionRequestClient } from './mobile-web-session-request-client'

export function mobileWebSessionClientBindings(client: MobileWebSessionRequestClient) {
  return {
    sessionCapabilities: client.capabilities.bind(client),
    sessionHostGates: client.hostGates.bind(client),
    sessionSnapshot: client.snapshot.bind(client),
    sessionActivate: client.activate.bind(client),
    sessionAgentOptions: client.agentOptions.bind(client),
    sessionQuickCommands: client.quickCommands.bind(client),
    sessionQuickCommandMutate: client.quickCommandMutate.bind(client),
    sessionCreate: client.create.bind(client),
    sessionCreateAgent: client.createAgent.bind(client),
    sessionCreateQuickCommand: client.createQuickCommand.bind(client),
    sessionCreateBrowser: client.createBrowser.bind(client),
    sessionClose: client.close.bind(client)
  }
}
