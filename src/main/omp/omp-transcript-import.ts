import { homedir } from 'node:os'
import { resolveOmpSessionsDir } from '../ai-vault/scanners/omp/omp-session-root'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { findOmpSessionByCwd } from './omp-session-cwd-lookup'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'

function sessionsRoot(accountHomePath: string, launchEnv: NodeJS.ProcessEnv) {
  return resolveOmpSessionsDir({
    env: { ...launchEnv, PI_CODING_AGENT_DIR: accountHomePath },
    homeDir: (process.platform === 'win32' ? launchEnv.USERPROFILE : launchEnv.HOME) || homedir()
  })
}

export const OMP_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath, launchEnv }) => sessionsRoot(accountHomePath, launchEnv),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  // OMP sessions may live outside the account home through XDG_DATA_HOME.
  findTranscript: async ({ providerSessionId, store, launchEnv, workspaceCwd, strictErrors }) =>
    (await findOmpSessionByCwd({
      sessionsDir: store,
      sessionId: providerSessionId,
      cwd: workspaceCwd,
      homeDir: (process.platform === 'win32' ? launchEnv.USERPROFILE : launchEnv.HOME) || homedir(),
      env: launchEnv,
      strictErrors
    })) ??
    // A conversation saved in a sub-folder of the workspace sits in that folder's bucket.
    resolveSessionFilePath('omp', providerSessionId, { ompSessionsDir: store, strictErrors })
})
