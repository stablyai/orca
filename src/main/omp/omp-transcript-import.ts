import { homedir } from 'node:os'
import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'
import { findOmpSessionByCwd } from './omp-session-cwd-lookup'

function sessionsRoot(accountHomePath: string, launchEnv: NodeJS.ProcessEnv) {
  return resolveOmpSessionsDir({
    env: { ...launchEnv, PI_CODING_AGENT_DIR: accountHomePath },
    homeDir: (process.platform === 'win32' ? launchEnv.USERPROFILE : launchEnv.HOME) || homedir()
  })
}

export const OMP_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath, launchEnv }) => sessionsRoot(accountHomePath, launchEnv),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  // Where OMP itself keeps the account's sessions, which is not always under it (XDG_DATA_HOME).
  findTranscript: ({ providerSessionId, store, launchEnv, workspaceCwd, strictErrors }) =>
    findOmpSessionByCwd({
      sessionsDir: store,
      sessionId: providerSessionId,
      cwd: workspaceCwd,
      homeDir: (process.platform === 'win32' ? launchEnv.USERPROFILE : launchEnv.HOME) || homedir(),
      env: launchEnv,
      strictErrors
    })
})
