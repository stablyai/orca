import { basename, dirname } from 'node:path'
import { resolveDshSessionsDir } from '../../../../shared/dsh-session-log'
import type { AiVaultAgentSource } from '../../discovery/session-scanner-agent-sources'
import { sessionRootDirs } from '../../discovery/session-scanner-roots'
import type { FileWithMtime } from '../../session-scanner-types'

const DSH_SESSION_LOG_NAME = /^session\.v(\d+)\.jsonl(\.zstd)?$/

/** Higher format generations win; the compressed copy wins a same-generation tie. */
function dshSessionLogRank(filePath: string): number {
  const match = DSH_SESSION_LOG_NAME.exec(basename(filePath))
  if (!match) {
    return -1
  }
  return Number.parseInt(match[1], 10) * 2 + (match[2] === '.zstd' ? 1 : 0)
}

/** dsh writes one log per session directory, and a migration can leave two generations behind. */
export function selectDshSessionLogs(files: readonly FileWithMtime[]): FileWithMtime[] {
  const winnerByDir = new Map<string, FileWithMtime>()
  for (const file of files) {
    const dir = dirname(file.path)
    const current = winnerByDir.get(dir)
    if (!current || dshSessionLogRank(file.path) > dshSessionLogRank(current.path)) {
      winnerByDir.set(dir, file)
    }
  }
  return [...winnerByDir.values()]
}

export const DSH_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) =>
    sessionRootDirs(resolveDshSessionsDir(options.dshSessionsDir), wslHomeDirs, [
      '.dsh',
      'sessions'
    ]),
  extensions: ['.zstd', '.jsonl'],
  filePredicate: (filePath) => DSH_SESSION_LOG_NAME.test(basename(filePath)),
  selectFiles: selectDshSessionLogs
}
