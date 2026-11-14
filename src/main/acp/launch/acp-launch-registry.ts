import { join } from 'node:path'
import { GROK_ACP_DIALECT } from '../acp-dialects/grok-dialect'
import { OMP_ACP_DIALECT } from '../acp-dialects/omp-dialect'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { directoryAccountBinding } from './acp-account-binding'
import { openCodeAcpAccountBinding } from '../../opencode/accounts/opencode-structured-account-home'
import { scrubOpenCodeAcpEnvironment } from '../../opencode/acp/opencode-acp-environment'
import { compareAppVersions } from '../../../shared/app-version'
import { readGrokModelCatalog } from '../acp-dialects/grok-model-catalog'
import {
  OPENCODE_MODEL_LISTING_ARGS,
  parseOpenCodeModelListing
} from '../../opencode/model-launch/opencode-model-catalog-listing'

import { agentSessionSetupFor } from '../../../shared/agent-session/lifecycle/agent-session-setup-commands'
import {
  loadGrokVisualsSkill,
  loadOmpVisualsSkill,
  loadOpenCodeVisualsSkill
} from './acp-visuals-skill'

import { GROK_SESSION_HISTORY } from '../../grok/grok-session-history'
import { GROK_TRANSCRIPT_IMPORT } from '../../grok/grok-transcript-import'
import { OPENCODE_SESSION_HISTORY } from '../../opencode/transcripts/opencode-session-history'
import { OPENCODE_TRANSCRIPT_IMPORT } from '../../opencode/transcripts/opencode-transcript-import'
import { assertOpenCodeCopyUsesLocalStore } from '../../../shared/opencode-launch-command'
import { OMP_SESSION_HISTORY } from '../../omp/omp-session-history'
import { OMP_TRANSCRIPT_IMPORT } from '../../omp/omp-transcript-import'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import { COPILOT_LAUNCH_SPEC } from '../../copilot/copilot-acp-launch-spec'
import { KIMI_LAUNCH_SPEC } from '../../kimi/kimi-acp-launch-spec'
import type { AcpLaunchSpec } from './acp-launch-contract'

const GROK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'grok',
  command: 'grok',
  args: ({ fullAccess, pluginDir }) => [
    'agent',
    ...(fullAccess ? ['--always-approve'] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    'stdio'
  ],
  env: {},
  dialect: GROK_ACP_DIALECT,
  historyCatchUp: 'prompt-id',
  loginCommand: agentSessionSetupFor('grok')?.loginCommand ?? [],
  // Prefer the launch environment's API key, then cached sign-in; never prompt interactively.
  authMethod: ({ advertised, env }) =>
    env.XAI_API_KEY?.trim() && advertised.includes('xai.api_key')
      ? 'xai.api_key'
      : advertised.includes('cached_token')
        ? 'cached_token'
        : undefined,
  account: directoryAccountBinding('GROK_HOME', (homePath) => join(homePath, '.grok')),
  installDirectories: ({ env }) => (env.GROK_HOME ? [join(env.GROK_HOME, 'bin')] : []),
  // initialize's currentModelId can differ from a session's; leave the default to the chat.
  modelDiscovery: {
    kind: 'initialize',
    read: readGrokModelCatalog,
    listingNamesConfiguredModel: false
  },
  visualsSkill: loadGrokVisualsSkill,
  compaction: true,
  transcriptImport: GROK_TRANSCRIPT_IMPORT,
  sessionHistory: GROK_SESSION_HISTORY
}

// Verified release lines: 1.18.31 recordings and 2.0.14 private-child startup.
const OPENCODE_MINIMUM_VERSIONS = ['1.18.31', '2.0.14'] as const

// 1.x serves in-process; 2.x passes this environment to a private serve --stdio child.
function openCodeLaunchSpec(
  row: Pick<AcpLaunchSpec, 'agent' | 'command' | 'minimumVersions' | 'modelDiscovery'>
): AcpLaunchSpec {
  return {
    ...row,
    // No bypass flag; full access approves permission requests individually.
    args: () => ['acp'],
    // 1.x cannot answer ACP questions; 2.x ignores this guard and negotiates form support.
    env: { OPENCODE_CLIENT: 'acp', OPENCODE_ENABLE_QUESTION_TOOL: 'false' },
    scrubEnvironment: scrubOpenCodeAcpEnvironment,
    dialect: OPENCODE_ACP_DIALECT,
    historyCatchUp: 'user-message-id',
    loginCommand: agentSessionSetupFor(row.agent)?.loginCommand ?? [],
    account: openCodeAcpAccountBinding(),
    installDirectories: ({ homePath }) => [join(homePath, '.opencode', 'bin')],
    visualsSkill: loadOpenCodeVisualsSkill,
    compaction: true,
    assertCopyLaunchArgs: assertOpenCodeCopyUsesLocalStore,
    transcriptImport: OPENCODE_TRANSCRIPT_IMPORT,
    sessionHistory: OPENCODE_SESSION_HISTORY
  }
}

const OPENCODE_LAUNCH_SPEC = openCodeLaunchSpec({
  agent: 'opencode',
  command: 'opencode',
  minimumVersions: OPENCODE_MINIMUM_VERSIONS,
  // 1.x lists via CLI; 2.x requires a disposable session.
  modelDiscovery: {
    kind: 'command',
    args: OPENCODE_MODEL_LISTING_ARGS,
    parse: parseOpenCodeModelListing,
    listingNamesConfiguredModel: false,
    // 2.x and later reject `--verbose`, and their listings omit providers that report after startup.
    supportsVersion: (version) => compareAppVersions(version, '2.0.0') < 0,
    otherReleasesListInSession: true
  }
})

// opencode2 is the installer's 2.x alias; both names share accounts and history.
const OPENCODE2_LAUNCH_SPEC = openCodeLaunchSpec({
  agent: 'opencode2',
  command: 'opencode2',
  minimumVersions: ['2.0.14'],
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false }
})

const OMP_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'omp',
  command: 'omp',
  // Full access approves permission requests individually.
  args: ({ pluginDir, model }) => [
    'acp',
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    ...(model ? ['--model', model] : [])
  ],
  // ACP takes listed provider/id values only; the CLI also resolves roles, fallbacks and :level.
  launchesWithModel: true,
  // Answering forms marks the session as having a UI, so `pty: true` bash would open a TUI
  // overlay ACP cannot draw and fail; OMP's own headless modes set this too.
  env: { PI_NO_PTY: '1' },
  dialect: OMP_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('omp')?.loginCommand ?? [],
  account: directoryAccountBinding('PI_CODING_AGENT_DIR', (homePath) =>
    join(homePath, '.omp', 'agent')
  ),
  installDirectories: () => [],
  // First release verified to serve ACP.
  minimumVersions: ['17.0.5'],
  // CLI listings include disabled models; use a disposable session (OMP cannot delete sessions).
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    sessionFolderArgs: (folder) => ['--session-dir', folder]
  },
  visualsSkill: loadOmpVisualsSkill,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: OMP_TRANSCRIPT_IMPORT,
  sessionHistory: OMP_SESSION_HISTORY
}

export const ACP_LAUNCH_SPECS: readonly AcpLaunchSpec[] = [
  GROK_LAUNCH_SPEC,
  OPENCODE_LAUNCH_SPEC,
  OPENCODE2_LAUNCH_SPEC,
  OMP_LAUNCH_SPEC,
  ANTIGRAVITY_LAUNCH_SPEC,
  COPILOT_LAUNCH_SPEC,
  KIMI_LAUNCH_SPEC
]

export function acpLaunchSpecFor(agent: string): AcpLaunchSpec | null {
  return ACP_LAUNCH_SPECS.find((spec) => spec.agent === agent) ?? null
}
