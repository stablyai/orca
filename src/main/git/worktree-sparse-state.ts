import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { GitRuntimeOptions } from './git-runtime-options'
import { resolveGitDir } from './status'

export async function detectSparseCheckout(
  worktreePath: string,
  // Why: git in a WSL distro reports the worktree, and writes its gitdir pointer, in the guest
  // namespace; without the distro this stats a path Win32 fabricates and reads "not sparse".
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<boolean> {
  // Why: fs.stat the per-worktree gitdir's sparse-checkout pattern file instead of a per-poll `git sparse-checkout list` subprocess that regressed responsiveness (PR #1290);
  // this is the cheap fast-path gate before the enabled check below.
  try {
    const gitDir = await resolveGitDir(worktreePath, options)
    const stats = await stat(join(gitDir, 'info', 'sparse-checkout'))
    if (!stats.isFile() || stats.size === 0) {
      return false
    }
    // Why the extra config read: `git sparse-checkout disable` restores every file to the
    // working tree and sets core.sparseCheckout=false, but it deliberately LEAVES
    // <gitdir>/info/sparse-checkout in place so the checkout can be re-enabled with the same
    // patterns. A non-empty pattern file is therefore necessary but not sufficient — without
    // confirming core.sparseCheckout is actually on we would flag a fully-populated worktree as
    // sparse and show a misleading "files are not on disk" badge. This runs only for the rare
    // worktree that still has a non-empty pattern file, so it does not reintroduce the per-poll
    // subprocess fan-out PR #1290 removed, and it reads git's config files directly (no
    // subprocess) so it stays cheap and needs no exec options.
    return await isSparseCheckoutEnabled(gitDir)
  } catch {
    return false
  }
}

// Resolve the shared common gitdir for a (possibly linked) worktree gitdir. A linked worktree's
// gitdir holds a `commondir` file pointing at the repo's main `.git`; the main worktree's gitdir
// is itself the common dir.
export async function resolveGitCommonDir(gitDir: string): Promise<string> {
  try {
    const raw = (await readFile(join(gitDir, 'commondir'), 'utf-8')).trim()
    if (raw.length > 0) {
      return isAbsolute(raw) ? raw : resolve(gitDir, raw)
    }
  } catch {
    // No `commondir` file: this gitdir is already the common dir.
  }
  return gitDir
}

// Whether core.sparseCheckout is actually enabled for this worktree. The value can live in the
// shared repo config or, when extensions.worktreeConfig is on, in the worktree-local
// `config.worktree`; later files override earlier ones, matching git's config precedence.
async function isSparseCheckoutEnabled(gitDir: string): Promise<boolean> {
  const commonDir = await resolveGitCommonDir(gitDir)
  const sharedConfig = await readGitConfigText(join(commonDir, 'config'))
  const sharedFlag = parseCoreSparseCheckoutFlag(sharedConfig)
  // Git reads `config.worktree` only while extensions.worktreeConfig is on; without that gate a
  // stale worktree config left behind by an earlier sparse checkout overrides the real repo value.
  if (parseGitConfigFlag(sharedConfig, 'extensions', 'worktreeconfig') !== true) {
    return sharedFlag ?? false
  }
  const worktreeConfig = await readGitConfigText(join(gitDir, 'config.worktree'))
  return parseCoreSparseCheckoutFlag(worktreeConfig) ?? sharedFlag ?? false
}

async function readGitConfigText(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, 'utf-8')
  } catch {
    return ''
  }
}

// Read the effective `core.sparseCheckout` boolean from one git config file's text, or `undefined`
// when the plain `[core]` section does not set it. Kept as a pure, exported function so the
// git-config parsing edge cases can be unit tested without touching the filesystem. Only the last
// assignment wins, and a `[core "subsection"]` header is intentionally not treated as `[core]`.
export function parseCoreSparseCheckoutFlag(configContent: string): boolean | undefined {
  return parseGitConfigFlag(configContent, 'core', 'sparsecheckout')
}

// A section header may be followed on the same line by further headers and then one assignment
// (`[core] sparseCheckout = true` is legal git config); the value runs to end of line, so at most
// one assignment can share a line and the last header before it decides the section.
const GIT_CONFIG_SECTION_HEADER = /^\[\s*([A-Za-z0-9.-]+)(\s+"(?:[^"\\]|\\.)*")?\s*\]/
const GIT_CONFIG_ASSIGNMENT = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/

// `section` and `key` must be lowercase: git config names are case-insensitive.
function parseGitConfigFlag(
  configContent: string,
  section: string,
  key: string
): boolean | undefined {
  let inSection = false
  let value: boolean | undefined
  for (const rawLine of configContent.split(/\r?\n/)) {
    let rest = stripGitConfigComment(rawLine).trim()
    for (
      let header = rest.match(GIT_CONFIG_SECTION_HEADER);
      header;
      header = rest.match(GIT_CONFIG_SECTION_HEADER)
    ) {
      inSection = header[1].toLowerCase() === section && header[2] === undefined
      rest = rest.slice(header[0].length).trim()
    }
    if (!inSection || rest.length === 0) {
      continue
    }
    const assignment = rest.match(GIT_CONFIG_ASSIGNMENT)
    if (!assignment || assignment[1].toLowerCase() !== key) {
      continue
    }
    value = parseGitConfigBoolean(assignment[2])
  }
  return value
}

// Drop a trailing `#`/`;` comment that is not inside a double-quoted value.
function stripGitConfigComment(line: string): string {
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index - 1] !== '\\') {
      inQuotes = !inQuotes
    } else if ((char === '#' || char === ';') && !inQuotes) {
      return line.slice(0, index)
    }
  }
  return line
}

// Git treats a valueless boolean (`sparseCheckout` with no `=`) as true and only true/yes/on/1 as
// true otherwise; everything else (including the disable-written `false`) is false.
function parseGitConfigBoolean(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true
  }
  const value = raw
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .toLowerCase()
  return value === 'true' || value === 'yes' || value === 'on' || value === '1'
}
