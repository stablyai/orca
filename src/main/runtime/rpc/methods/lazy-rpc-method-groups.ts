import { prefixRpcMethodGroup, type LazyRpcMethodGroup } from '../lazy-rpc-method-group'

export const DEFAULT_LAZY_RPC_METHOD_GROUPS: readonly LazyRpcMethodGroup[] = [
  prefixRpcMethodGroup(
    ['bots.', 'mcpServers.', 'webhooks.'],
    async () => (await import('./bot-rpc-methods')).BOT_RPC_METHODS,
    { exactNames: ['worktree.releaseBotHome'] }
  ),
  prefixRpcMethodGroup(['connector.'], async () => {
    const [{ CONNECTOR_METHODS }, { CONNECTOR_SLACK_MIRROR_METHODS }] = await Promise.all([
      import('./connectors/connector'),
      import('./connectors/connector-slack-mirror')
    ])
    return [...CONNECTOR_METHODS, ...CONNECTOR_SLACK_MIRROR_METHODS]
  }),
  prefixRpcMethodGroup(['google.'], async () => {
    const [
      { GOOGLE_METHODS },
      { GOOGLE_READ_METHODS },
      { GOOGLE_FILES_METHODS },
      { GOOGLE_WRITE_METHODS }
    ] = await Promise.all([
      import('./google'),
      import('./google-read'),
      import('./google-files'),
      import('./google-write')
    ])
    return [
      ...GOOGLE_METHODS,
      ...GOOGLE_READ_METHODS,
      ...GOOGLE_FILES_METHODS,
      ...GOOGLE_WRITE_METHODS
    ]
  }),
  prefixRpcMethodGroup(
    ['emulator.'],
    async () => (await import('./emulator/emulator')).EMULATOR_METHODS
  ),
  prefixRpcMethodGroup(['speech.'], async () => (await import('./speech/speech')).SPEECH_METHODS),
  prefixRpcMethodGroup(
    ['gitlab.'],
    async () => (await import('./source-control/gitlab/gitlab')).GITLAB_METHODS
  ),
  prefixRpcMethodGroup(
    ['hostedReview.'],
    async () => (await import('./source-control/reviews/hosted-review')).HOSTED_REVIEW_METHODS
  ),
  prefixRpcMethodGroup(['linear.'], async () => {
    const [{ LINEAR_METHODS }, { LINEAR_AGENT_ACCESS_METHODS }] = await Promise.all([
      import('./integrations/linear/linear'),
      import('./integrations/linear/linear-agent-access')
    ])
    return [...LINEAR_METHODS, ...LINEAR_AGENT_ACCESS_METHODS]
  }),
  prefixRpcMethodGroup(
    ['jira.'],
    async () => (await import('./integrations/jira/jira')).JIRA_METHODS,
    { streamingNames: ['jira.attachmentImage', 'jira.getIssueStream', 'jira.issueCommentsStream'] }
  ),
  prefixRpcMethodGroup(
    ['computer.'],
    async () => (await import('./computer/computer')).COMPUTER_METHODS
  ),
  prefixRpcMethodGroup(['automation.', 'runtime.automaticWork.'], async () => {
    const [{ AUTOMATION_METHODS }, { AUTOMATIC_WORK_METHODS }] = await Promise.all([
      import('./automations/automations'),
      import('./automations/automatic-work')
    ])
    return [...AUTOMATION_METHODS, ...AUTOMATIC_WORK_METHODS]
  }),
  prefixRpcMethodGroup(
    ['artifacts.'],
    async () => (await import('./artifacts/artifacts')).ARTIFACT_METHODS
  ),
  prefixRpcMethodGroup(['skills.'], async () => (await import('./skills/skills')).SKILL_METHODS),
  prefixRpcMethodGroup(
    ['linkPreview.'],
    async () => (await import('./link-preview/link-preview')).LINK_PREVIEW_METHODS
  ),
  prefixRpcMethodGroup(
    ['diagnostics.'],
    async () => (await import('./host-management/diagnostics')).DIAGNOSTICS_METHODS
  ),
  prefixRpcMethodGroup(
    ['managedServer.'],
    async () => (await import('./host-management/managed-server')).MANAGED_SERVER_METHODS
  ),
  prefixRpcMethodGroup(['ssh.'], async () => (await import('./ssh/ssh')).SSH_METHODS),
  prefixRpcMethodGroup(['plugins.'], async () => {
    const [
      { PLUGIN_METHODS },
      { PLUGIN_VIEW_METHODS },
      { PLUGIN_DEV_EMIT_METHODS },
      { PLUGIN_DEV_REQUEST_METHODS },
      { PLUGIN_INSTALL_METHODS }
    ] = await Promise.all([
      import('./plugins/plugins'),
      import('./plugins/plugin-view'),
      import('./plugins/plugin-dev-emit'),
      import('./plugins/plugin-dev-request'),
      import('./plugins/plugin-install-methods')
    ])
    return [
      ...PLUGIN_METHODS,
      ...PLUGIN_VIEW_METHODS,
      ...PLUGIN_DEV_EMIT_METHODS,
      ...PLUGIN_DEV_REQUEST_METHODS,
      ...PLUGIN_INSTALL_METHODS
    ]
  }),
  prefixRpcMethodGroup(
    ['updater.'],
    async () => (await import('./updater/updater')).UPDATER_METHODS
  ),
  prefixRpcMethodGroup(
    ['aiVault.'],
    async () => (await import('./history/ai-vault')).AI_VAULT_METHODS
  ),
  prefixRpcMethodGroup(
    ['preflight.'],
    async () => (await import('./preflight/preflight')).PREFLIGHT_METHODS
  ),
  prefixRpcMethodGroup(
    ['workspacePorts.'],
    async () => (await import('./workspace-ports/workspace-ports')).WORKSPACE_PORT_METHODS
  ),
  prefixRpcMethodGroup(
    [],
    async () =>
      (await import('./workspace-ports/network-port-forward')).NETWORK_PORT_FORWARD_METHODS,
    { exactNames: ['network.portForward'], streamingNames: ['network.portForward'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./host-management/recipe-vm-wake')).RECIPE_VM_WAKE_METHODS,
    { exactNames: ['runtimeEnvironment.wakeRecipeVm'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./host-management/environment-doctor')).ENVIRONMENT_DOCTOR_METHODS,
    { exactNames: ['environment.doctor'] }
  ),
  prefixRpcMethodGroup(
    ['managedRuntime.'],
    async () =>
      (await import('./host-management/managed-runtime-install')).MANAGED_RUNTIME_INSTALL_METHODS,
    { streamingNames: ['managedRuntime.subscribe'] }
  ),
  prefixRpcMethodGroup(
    ['agentCliUpdate.'],
    async () => (await import('./host-management/agent-cli-update')).AGENT_CLI_UPDATE_METHODS,
    { streamingNames: ['agentCliUpdate.subscribe'] }
  ),
  prefixRpcMethodGroup(
    ['pairing.'],
    async () => (await import('./pairing/pairing')).PAIRING_METHODS,
    { exactNames: ['host.peerDesktops', 'host.declareClient', 'host.declareAccount'] }
  ),
  prefixRpcMethodGroup(['mobileRelay.', 'mobileWeb.'], async () => {
    const [
      { MOBILE_RELAY_HOSTS_METHODS },
      { MOBILE_PROJECT_SECTIONS_METHODS },
      { MOBILE_WEB_BUNDLE_METHODS }
    ] = await Promise.all([
      import('./pairing/mobile-relay-hosts'),
      import('./mobile-delivery/mobile-project-sections'),
      import('./mobile-delivery/mobile-web-bundle')
    ])
    return [
      ...MOBILE_RELAY_HOSTS_METHODS,
      ...MOBILE_PROJECT_SECTIONS_METHODS,
      ...MOBILE_WEB_BUNDLE_METHODS
    ]
  }),
  prefixRpcMethodGroup(
    ['orchestration.'],
    async () => (await import('./orchestration/orchestration')).ORCHESTRATION_METHODS,
    {
      streamingNames: [
        'orchestration.crewSubscribe',
        'orchestration.workerApprovalsSubscribe',
        'orchestration.workerDockSubscribe'
      ]
    }
  ),
  prefixRpcMethodGroup(
    ['browser.', 'desktopBrowserBridge.'],
    async () => {
      const [
        { BROWSER_CORE_METHODS },
        { BROWSER_IDENTITY_METHODS },
        { BROWSER_SCREENCAST_METHODS },
        { BROWSER_GRAB_METHODS },
        { BROWSER_EXTRA_METHODS },
        { BROWSER_CLIENT_HOST_METHODS },
        { DESKTOP_BROWSER_BRIDGE_RPC_METHODS },
        { BROWSER_CLIENT_FILE_CHANNEL_METHODS },
        { BROWSER_NETWORK_TUNNEL_METHODS }
      ] = await Promise.all([
        import('./browser/browser-core'),
        import('./browser/browser-identity-rpc'),
        import('./browser/browser-screencast'),
        import('./browser/browser-grab'),
        import('./browser/browser-extras'),
        import('./browser/browser-client-host'),
        import('./browser/desktop-browser-bridge'),
        import('./browser/browser-client-file-channel'),
        import('./browser/browser-network-tunnel')
      ])
      return [
        ...BROWSER_CORE_METHODS,
        ...BROWSER_IDENTITY_METHODS,
        ...BROWSER_SCREENCAST_METHODS,
        ...BROWSER_GRAB_METHODS,
        ...BROWSER_EXTRA_METHODS,
        ...BROWSER_CLIENT_HOST_METHODS,
        ...DESKTOP_BROWSER_BRIDGE_RPC_METHODS,
        ...BROWSER_CLIENT_FILE_CHANNEL_METHODS,
        ...BROWSER_NETWORK_TUNNEL_METHODS
      ]
    },
    {
      exactNames: ['network.browserTunnel'],
      streamingNames: [
        'browser.screencast',
        'browser.downloadCopyStream',
        'browser.grab.watch',
        'browser.clientHost.attach',
        'desktopBrowserBridge.attach',
        'network.browserTunnel'
      ]
    }
  ),
  prefixRpcMethodGroup(
    ['accounts.'],
    async () => {
      const [{ ACCOUNT_METHODS }, { ANTIGRAVITY_ACCOUNT_METHODS }, { USAGE_CREDENTIAL_METHODS }] =
        await Promise.all([
          import('./accounts/accounts'),
          import('./accounts/antigravity-accounts'),
          import('./accounts/usage-credentials')
        ])
      return [...ACCOUNT_METHODS, ...ANTIGRAVITY_ACCOUNT_METHODS, ...USAGE_CREDENTIAL_METHODS]
    },
    { streamingNames: ['accounts.subscribe', 'accounts.antigravityChatSignInSubscribe'] }
  ),
  prefixRpcMethodGroup(
    ['orcaAccount.'],
    async () => (await import('./orca-account')).ORCA_ACCOUNT_METHODS,
    { streamingNames: ['orcaAccount.subscribe'] }
  ),
  prefixRpcMethodGroup(
    ['github.'],
    async () => (await import('./source-control/github/github')).GITHUB_METHODS
  ),
  prefixRpcMethodGroup(
    ['stats.'],
    async () => (await import('./host-management/stats')).STATS_METHODS
  ),
  prefixRpcMethodGroup(
    ['usage.'],
    async () => (await import('./host-management/usage-analytics')).USAGE_ANALYTICS_METHODS
  ),
  prefixRpcMethodGroup(
    ['pairedServerAsks.'],
    async () =>
      (await import('./paired-server-asks/paired-server-asks-methods')).PAIRED_SERVER_ASKS_METHODS
  ),
  prefixRpcMethodGroup(
    ['reference.'],
    async () => (await import('./reference/reference')).REFERENCE_METHODS
  )
]
