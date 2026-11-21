import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GEMINI_ACP_DIALECT } from '../acp/acp-dialects/gemini-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverGeminiInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Gemini's session store; `--resume` also takes `latest` or a list index.
const GEMINI_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['gemini'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) => {
    const invocation = resumeInvocationFromOptions(args, {
      targetless: [],
      markers: ['-r', '--resume']
    })
    return invocation?.target === 'latest' || /^\d+$/u.test(invocation?.target ?? '')
      ? { target: null }
      : invocation
  }
}

// Signed out, Gemini prints a manual sign-in URL, then reads the code from stdin, where ACP frames arrive.
function readGeminiSignInLine(line: string): string | null | undefined {
  const text = line.trim()
  if (!text.startsWith('https://accounts.google.com/')) {
    return undefined
  }
  const url = URL.parse(text)
  return url?.pathname === '/o/oauth2/v2/auth' &&
    url.searchParams.get('redirect_uri') === 'https://codeassist.google.com/authcode'
    ? text
    : null
}

export const GEMINI_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'gemini',
  command: 'gemini',
  // No bypass flag; full access approves permission requests individually. The flag overrides a
  // saved `defaultApprovalMode`, which would otherwise approve edits while the chat shows Ask.
  args: () => ['--acp', '--approval-mode', 'default'],
  // Signed out, Gemini would otherwise open a browser on the chat host and wait for its sign-in.
  env: { NO_BROWSER: 'true' },
  dialect: GEMINI_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('gemini')?.loginCommand ?? [],
  signIn: { read: readGeminiSignInLine },
  // A home root: Gemini keeps its state in `.gemini` under it.
  account: directoryAccountBinding('GEMINI_CLI_HOME', (homePath) => homePath),
  installDirectories: () => [],
  // 0.68.0 finishes replaying a loaded session before answering session/load; earlier releases
  // keep replaying after it, so old history could mix into the next turn.
  minimumVersions: ['0.68.0'],
  // Only a signed-in session lists models, and Gemini cannot delete a listing session.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Gemini lists its models only inside a signed-in session'
  },
  instructions: deliverGeminiInstructions,
  instructionsInWorkspace: true,
  transcriptImport: null,
  sessionHistory: GEMINI_SESSION_HISTORY,
  // No session/close or delete: a naming task's session would stay in the user's Gemini history.
  keepsEverySession: true
}
