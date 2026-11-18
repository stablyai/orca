// What an importing bot may read of another app's files: names on the never-read list are refused. Lines
// that look like they hold a secret are left out by redactBotText (shared/bots/bot-text-scan).

/** Files and folders that hold keys, logins or chat history in OpenClaw, Hermes and OpenBot. */
const NEVER_READ_NAME =
  /^(\.env.*|auth\.json|(openclaw|clawdbot|moltbot)\.json|config\.ya?ml|auth-profiles.*|.*\.(pem|key|p12|keychain|keychain-db|sqlite|db|db-wal|db-shm)|.*(secret|token|credential|password).*)$/i
const NEVER_READ_FOLDER =
  /^(credentials|devices|identity|sessions|vault|mcp-tokens|logs|sandboxes|codex-home|\.git|node_modules)$/i

/** Why a path may not be read, or null when it may. */
export function botImportReadRefusal(path: string): string | null {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  const name = parts.at(-1) ?? ''
  if (
    parts.slice(0, -1).some((part) => NEVER_READ_FOLDER.test(part)) ||
    NEVER_READ_FOLDER.test(name)
  ) {
    return 'it is in a folder that holds keys, logins or chat history'
  }
  if (NEVER_READ_NAME.test(name)) {
    return 'it may hold keys or logins; read only the filtered commands for it'
  }
  return null
}
