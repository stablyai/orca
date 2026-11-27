import { prefixRpcMethodGroup, type LazyRpcMethodGroup } from '../lazy-rpc-method-group'

export const LAZY_INTEGRATION_RPC_METHOD_GROUPS: readonly LazyRpcMethodGroup[] = [
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
  )
]
