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
import { AI_VAULT_METHODS } from './history/ai-vault'
import { MANAGED_RUNTIME_INSTALL_METHODS } from './host-management/managed-runtime-install'
import { AGENT_CLI_UPDATE_METHODS } from './host-management/agent-cli-update'
import { SSH_METHODS } from './ssh/ssh'
import { PLUGIN_METHODS } from './plugins/plugins'
import { PLUGIN_VIEW_METHODS } from './plugins/plugin-view'
import { PLUGIN_DEV_EMIT_METHODS } from './plugins/plugin-dev-emit'
import { PLUGIN_DEV_REQUEST_METHODS } from './plugins/plugin-dev-request'
import { PLUGIN_INSTALL_METHODS } from './plugins/plugin-install-methods'
import { UPDATER_METHODS } from './updater/updater'
import { PREFLIGHT_METHODS } from './preflight/preflight'
import { WORKSPACE_PORT_METHODS } from './workspace-ports/workspace-ports'
import { NETWORK_PORT_FORWARD_METHODS } from './workspace-ports/network-port-forward'
import { RECIPE_VM_WAKE_METHODS } from './host-management/recipe-vm-wake'
import { ENVIRONMENT_DOCTOR_METHODS } from './host-management/environment-doctor'
import { PAIRING_METHODS } from './pairing/pairing'
import { MOBILE_RELAY_HOSTS_METHODS } from './pairing/mobile-relay-hosts'
import { MOBILE_PROJECT_SECTIONS_METHODS } from './mobile-delivery/mobile-project-sections'
import { MOBILE_WEB_BUNDLE_METHODS } from './mobile-delivery/mobile-web-bundle'

const CORE_RPC_METHODS = [
  ...EAGER_CORE_RPC_METHODS,
  ...ARTIFACT_METHODS,
  ...AUTOMATION_METHODS,
  ...CONNECTOR_METHODS,
  ...CONNECTOR_SLACK_MIRROR_METHODS,
  ...AI_VAULT_METHODS,
  ...MANAGED_RUNTIME_INSTALL_METHODS,
  ...AGENT_CLI_UPDATE_METHODS
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
  ...MANAGED_SERVER_METHODS,
  ...SSH_METHODS,
  ...PLUGIN_METHODS,
  ...PLUGIN_VIEW_METHODS,
  ...PLUGIN_DEV_EMIT_METHODS,
  ...PLUGIN_DEV_REQUEST_METHODS,
  ...PLUGIN_INSTALL_METHODS,
  ...UPDATER_METHODS,
  ...PREFLIGHT_METHODS,
  ...WORKSPACE_PORT_METHODS,
  ...NETWORK_PORT_FORWARD_METHODS,
  ...RECIPE_VM_WAKE_METHODS,
  ...ENVIRONMENT_DOCTOR_METHODS,
  ...PAIRING_METHODS,
  ...MOBILE_RELAY_HOSTS_METHODS,
  ...MOBILE_PROJECT_SECTIONS_METHODS,
  ...MOBILE_WEB_BUNDLE_METHODS
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
