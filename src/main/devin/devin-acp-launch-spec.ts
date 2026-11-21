import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DEVIN_ACP_DIALECT } from '../acp/acp-dialects/devin-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverDevinInstructions } from '../acp/launch/acp-instructions'
import { sessionIdFromFileName } from '../ai-vault/parsing/session-scanner-accumulator'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

/** `<data root>/devin/cli` holds the sign-in, the sessions and the transcripts: XDG_DATA_HOME on
 *  POSIX, and %APPDATA% on Windows, where the CLI reads no XDG variable and Orca's scanner reads the
 *  same root (#32043, #42334). */
const DEVIN_DATA_ROOT = process.platform === 'win32' ? 'APPDATA' : 'XDG_DATA_HOME'
const devinDataRoot = (homePath: string): string =>
  process.platform === 'win32'
    ? join(homePath, 'AppData', 'Roaming')
    : join(homePath, '.local', 'share')

/** `devin --resume` takes one session id, and `devin rm` refuses a prefix that names more than one
 *  session, so only the row's whole id matches; a transcript path matches through its file name. */
function devinResumeTargetMatches(target: string, rowSessionId: string): boolean {
  const id = rowSessionId.toLowerCase()
  return target.toLowerCase() === id || sessionIdFromFileName(target).toLowerCase() === id
}

// Chats and terminals share Devin's session store; `--resume` reopens a session by its id.
const DEVIN_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['devin'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    }),
  resumeTargetMatches: devinResumeTargetMatches
}

export const DEVIN_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'devin',
  command: 'devin',
  // Its REPL runs every ACP child in-process, and a daemon would own the session, outlive Orca and
  // keep the environment of whichever chat started it.
  args: () => ['acp', '--process-model', 'in-process'],
  env: {},
  // Each of these overrides what a picker showed or what the account pin holds: an inherited mode,
  // model or fallback model would run every chat under a selection the chat never made, a key or
  // API URL would spend someone else's credentials, and either session store variable would write
  // history outside the account. (`DEVIN_STORE` does not exist on 3000.14.30821; the store override
  // is DEVIN_SESSION_STORE.)
  scrubEnvironment: (env) => {
    const scrubbed = [
      'DEVIN_PERMISSION_MODE',
      'DEVIN_MODEL',
      'DEVIN_REFUSAL_FALLBACK',
      'DEVIN_SESSIONS_DIR',
      'DEVIN_SESSION_STORE',
      'DEVIN_SANDBOX',
      'DEVIN_API_URL',
      'WINDSURF_API_KEY'
    ]
    for (const key of scrubbed) {
      delete env[key]
    }
    return scrubbed
  },
  dialect: DEVIN_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('devin')?.loginCommand ?? [],
  // The pin holds the sign-in and the session store together. Its `trusted_workspaces.json` is not
  // Orca's: a chat on another account has no trusted list there, and ACP needs none — a session
  // starts in a folder the list does not name (checked on 3000.14.30821).
  account: directoryAccountBinding(DEVIN_DATA_ROOT, devinDataRoot),
  installDirectories: ({ env, homePath }) => {
    if (process.platform !== 'win32') {
      return [join(homePath, '.local', 'bin')]
    }
    // The PowerShell installer's namespace root: `%LOCALAPPDATA%\devin\cli\bin`.
    const localAppData = env.LOCALAPPDATA?.trim() || join(homePath, 'AppData', 'Local')
    return [join(localAppData, 'devin', 'cli', 'bin')]
  },
  // First release verified to serve ACP with the mode and model selects this spec sets. It is the
  // current release, not a claim about which older build first reported them.
  minimumVersions: ['3000.14.30821'],
  // Devin enforces its own modes; one select carries both them and Plan, so Orca's Plan toggle stays
  // off rather than write a mode the permission picker is showing. Ask stays Ask rather than a
  // coding mode: ACP has no per-action approval mode, and a missing mode fails the handshake closed.
  permissionModeConfig: {
    values: {
      ask: 'ask',
      'accept-edits': 'accept-edits',
      auto: 'smart',
      'full-access': 'bypass'
    }
  },
  // The whole catalog is a session select, and Devin deletes its listing session, as Goose and Kimi do.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  instructions: deliverDevinInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  transcriptImport: null,
  sessionHistory: DEVIN_SESSION_HISTORY
}
