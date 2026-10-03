import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'
import { sessionRootDirs } from './session-scanner-roots'

// Layout (kiro-cli V3): <home>/.kiro/sessions/<workspace-hash>/sess_<uuid>/session.json, with the
// transcript in a sibling messages.jsonl. Legacy V2 chats under sessions/cli/ use another format
// and are not listed.
export function resolveKiroSessionsDir(override?: string): string {
  return override?.trim() || join(homedir(), '.kiro', 'sessions')
}

export function isKiroSessionManifestPath(filePath: string): boolean {
  return basename(filePath) === 'session.json' && basename(dirname(filePath)).startsWith('sess_')
}

export function kiroMessagesPathForManifest(manifestPath: string): string {
  return join(dirname(manifestPath), 'messages.jsonl')
}

export const kiroAgentSource: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) =>
    sessionRootDirs(resolveKiroSessionsDir(options.kiroSessionsDir), wslHomeDirs, [
      '.kiro',
      'sessions'
    ]),
  extensions: ['.json'],
  filePredicate: isKiroSessionManifestPath,
  // Why: each turn appends to messages.jsonl, so its stat has to refresh the row too.
  contentDependencyPath: kiroMessagesPathForManifest,
  // Why: sessions sit at <hash>/sess_<uuid>/, so only those two levels are worth walking.
  directoryPredicate: (name, depth) => depth === 0 || (depth === 1 && name.startsWith('sess_'))
}
