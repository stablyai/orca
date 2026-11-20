import { lstat, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'

/**
 * The sign-in, MCP logins (including tokens set in config.toml) and Codex's encrypted credential
 * stores. A home whose history.jsonl is a link loses only these files on removal: what the link
 * reaches can't be told apart from private state by name, so nothing else is removed.
 */
const LOGIN_FILES = [
  'auth.json',
  '.credentials.json',
  'config.toml',
  'secrets/codex_auth.age',
  'secrets/mcp_oauth.age',
  'secrets/gateway_oauth.age',
  'secrets/local.age'
]

/** Skips a login file that is the file the history link reaches; throws if the link can't be checked. */
export async function removeLoginsBesideLinkedHistory(home: string): Promise<void> {
  const history = await stat(join(home, 'history.jsonl'), { bigint: true }).catch(
    (error: unknown) => {
      // A dangling link reaches no file, so it can't be one of these.
      const code = errnoCodeOrUnknown(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null
      }
      throw error
    }
  )
  for (const name of LOGIN_FILES) {
    const path = join(home, name)
    const file = await lstat(path, { bigint: true }).catch(() => null)
    if (!file || file.isDirectory()) {
      continue
    }
    if (history && file.dev === history.dev && file.ino === history.ino) {
      continue
    }
    // Removes a link itself, never what it points to.
    await rm(path, { force: true })
  }
}

/** The same for a WSL home, as bash lines run with the home in $home; exits after removing. */
export const LINKED_HISTORY_REMOVAL_SCRIPT = [
  'if [ -L "$home/history.jsonl" ]; then',
  '  if [ ! -e "$home/history.jsonl" ] && ! readlink -f -- "$home/history.jsonl" >/dev/null 2>&1; then',
  '    exit 1',
  '  fi',
  `  for name in ${LOGIN_FILES.join(' ')}; do`,
  '    file="$home/$name"',
  '    if [ -d "$file" ] || { [ ! -e "$file" ] && [ ! -L "$file" ]; }; then continue; fi',
  '    if [ ! -L "$file" ] && [ "$file" -ef "$home/history.jsonl" ]; then continue; fi',
  '    rm -f -- "$file" || exit 1',
  '  done',
  '  exit 0',
  'fi'
]
