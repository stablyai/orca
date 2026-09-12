import { chmodSync, statSync } from 'node:fs'
import { resolveTomlWritePath } from './config-toml-atomic-write'

/**
 * `config.toml` can carry secrets depending on how the user configured Codex —
 * an MCP server declared with `http_headers` holds its bearer token literally in
 * this file. Orca cannot tell from the outside whether a given user's config
 * does, so the mirror writes every copy at owner-only rather than inspecting the
 * content and guessing.
 */
export const CODEX_CONFIG_FILE_MODE = 0o600

/**
 * Brings a config file and its rolling backup up to the owner-only mode.
 *
 * The backup matters as much as the primary: every trust write copies the whole
 * file to `<config>.bak` before replacing it, so the backup holds the same bytes
 * and the same token. Repairing only the primary leaves the secret readable
 * beside it while the config looks fixed.
 *
 * Repair — rather than write-time enforcement alone — is the point twice over.
 * The mirror rewrites only when content changes, and the backup is refreshed
 * only when a trust write changes content, so in steady state neither is ever
 * rewritten and an already-loose file would keep that mode indefinitely. The
 * user most in need of this is the one whose files never change.
 *
 * POSIX only — on Windows `chmod` just toggles the read-only bit, so applying it
 * there would claim a protection the platform is not giving.
 */
export function enforceCodexConfigFileMode(
  path: string,
  onWarning?: (message: string) => void
): void {
  if (process.platform === 'win32') {
    return
  }
  // Why resolve first: the writer follows a symlinked config to its realpath
  // and backs up to `<realpath>.bak`. Deriving the backup from the lexical path
  // would chmod a file that does not exist and leave the real one loose.
  let writePath: string
  try {
    writePath = resolveTomlWritePath(path)
  } catch (error) {
    // A dangling symlink is the case that gets here: `lstat` succeeds on the link,
    // so the resolver calls `realpath` and that throws ENOENT. The writer wants that
    // throw — it fails closed rather than replacing a dotfiles symlink — but this
    // repair must not, or the exception escapes into the mirror's catch and disables
    // the whole config mirror on every later pass. Fall back to the lexical path:
    // there is no realpath to repair, and `enforceOneFileMode` treats it as absent.
    onWarning?.(`could not resolve the write path for ${path}: ${String(error)}`)
    writePath = path
  }
  enforceOneFileMode(writePath, onWarning)
  enforceOneFileMode(`${writePath}.bak`, onWarning)
}

function enforceOneFileMode(path: string, onWarning?: (message: string) => void): void {
  let currentMode: number
  try {
    currentMode = statSync(path).mode & 0o777
  } catch (error) {
    // Absence is the normal case for the backup, and a missing config is the
    // caller's concern rather than this repair's. Anything else is worth saying.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      onWarning?.(`could not read the mode of ${path}: ${String(error)}`)
    }
    return
  }
  if (currentMode === CODEX_CONFIG_FILE_MODE) {
    return
  }
  try {
    chmodSync(path, CODEX_CONFIG_FILE_MODE)
  } catch (error) {
    // Why report: this is a security repair. Failing silently leaves a
    // world-readable credential file behind while the caller believes the mode
    // was corrected. It still must never be the reason a Codex launch fails.
    onWarning?.(
      `could not restrict ${path} from ${currentMode.toString(8)} to 600: ${String(error)}`
    )
  }
}
