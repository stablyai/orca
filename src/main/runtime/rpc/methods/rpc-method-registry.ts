import { EAGER_CORE_RPC_METHODS, EAGER_SERVICE_RPC_METHODS } from './eager-rpc-method-registry'
import { BOT_RPC_METHODS } from './bot-rpc-methods'
import { CONNECTOR_METHODS } from './connectors/connector'
import { CONNECTOR_SLACK_MIRROR_METHODS } from './connectors/connector-slack-mirror'
import { GOOGLE_METHODS } from './google'
import { GOOGLE_READ_METHODS } from './google-read'
import { GOOGLE_FILES_METHODS } from './google-files'
import { GOOGLE_WRITE_METHODS } from './google-write'
import { SPEECH_METHODS } from './speech/speech'
import { EMULATOR_METHODS } from './emulator/emulator'
import { GITLAB_METHODS } from './source-control/gitlab/gitlab'
import { HOSTED_REVIEW_METHODS } from './source-control/reviews/hosted-review'
import { LINEAR_METHODS } from './integrations/linear/linear'
import { LINEAR_AGENT_ACCESS_METHODS } from './integrations/linear/linear-agent-access'
import { JIRA_METHODS } from './integrations/jira/jira'
import { COMPUTER_METHODS } from './computer/computer'
import { AUTOMATION_METHODS } from './automations/automations'
import { AUTOMATIC_WORK_METHODS } from './automations/automatic-work'
import { ARTIFACT_METHODS } from './artifacts/artifacts'
import { SKILL_METHODS } from './skills/skills'
import { LINK_PREVIEW_METHODS } from './link-preview/link-preview'
import { DIAGNOSTICS_METHODS } from './host-management/diagnostics'
import { MANAGED_SERVER_METHODS } from './host-management/managed-server'

const CORE_RPC_METHODS = [
  ...EAGER_CORE_RPC_METHODS,
  ...ARTIFACT_METHODS,
  ...AUTOMATION_METHODS,
  ...CONNECTOR_METHODS,
  ...CONNECTOR_SLACK_MIRROR_METHODS
] as const

const SERVICE_RPC_METHODS = [
  ...EAGER_SERVICE_RPC_METHODS,
  ...GOOGLE_METHODS,
  ...GOOGLE_READ_METHODS,
  ...GOOGLE_FILES_METHODS,
  ...GOOGLE_WRITE_METHODS,
  ...SPEECH_METHODS,
  ...EMULATOR_METHODS,
  ...GITLAB_METHODS,
  ...HOSTED_REVIEW_METHODS,
  ...LINEAR_METHODS,
  ...LINEAR_AGENT_ACCESS_METHODS,
  ...JIRA_METHODS,
  ...COMPUTER_METHODS,
  ...AUTOMATIC_WORK_METHODS,
  ...SKILL_METHODS,
  ...LINK_PREVIEW_METHODS,
  ...DIAGNOSTICS_METHODS,
  ...MANAGED_SERVER_METHODS
] as const

type ConcatMethods<A extends readonly unknown[], B extends readonly unknown[]> = readonly [
  ...A,
  ...B
]

// Named segments keep declaration serialization bounded without erasing method params.
export const ALL_RPC_METHODS: ConcatMethods<
  ConcatMethods<typeof CORE_RPC_METHODS, typeof BOT_RPC_METHODS>,
  typeof SERVICE_RPC_METHODS
> = [...CORE_RPC_METHODS, ...BOT_RPC_METHODS, ...SERVICE_RPC_METHODS] as const
