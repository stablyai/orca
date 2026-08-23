// Shared orchestration for turning an existing (non-git) folder into a git
// repository in place. The git/filesystem calls are injected so the same logic
// drives both the local path (node fs + gitExecFileAsync) and the SSH/remote
// path (filesystem + git providers) — see src/main/ipc/repos.ts.

export const CONVERT_INITIAL_COMMIT_MESSAGE = 'Initial commit'

// Why: laid down before the first `add` so a folder with secrets (.env) or
// heavy generated dirs (node_modules) doesn't bake them into history during
// conversion. Conservative on purpose — only the near-universal cases — and we
// never overwrite a .gitignore the user already has.
export const DEFAULT_CONVERT_GITIGNORE = `# Created by Orca when this folder was converted to a Git repository.
# Keeps secrets and generated files out of version control — edit as needed.

# Secrets & credentials
.env
.env.*
!.env.example
!.env.sample
*.pem
*.key
id_rsa
id_rsa.*

# Dependencies
node_modules/

# Build output
dist/
build/
.next/
out/

# Logs
*.log

# OS files
.DS_Store
Thumbs.db
`

export type ConvertGitStep = 'init' | 'gitignore' | 'stage' | 'commit'

export type ConvertGitOps = {
  /** Run a git subcommand inside the target folder. */
  exec: (args: string[]) => Promise<void>
  /** Whether the folder already has a .gitignore (an existing one is respected). */
  hasGitignore: () => Promise<boolean>
  /** Write the default .gitignore into the folder. */
  writeGitignore: (content: string) => Promise<void>
}

export type ConvertGitResult =
  | { ok: true }
  | { ok: false; step: ConvertGitStep; message: string; isIdentityError: boolean }

// Shown when `git commit` fails because no author identity is configured. The
// SSH/remote path uses its own host-specific variant.
export const GIT_IDENTITY_NOT_CONFIGURED_MESSAGE =
  'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'

/** Maps a failed conversion step to a user-facing label (shared by all paths). */
export function convertStepLabel(step: ConvertGitStep): string {
  if (step === 'init') {
    return 'Failed to initialize git repository'
  }
  if (step === 'commit') {
    return 'Failed to create initial commit'
  }
  return 'Failed to convert folder to a git repository'
}

// Matches git's "no author identity" failure so callers can surface a fix-it
// hint instead of a raw git error.
const GIT_IDENTITY_HINT = /Please tell me who you are|user\.name|user\.email/i

/**
 * Initialize git in an already-populated folder: `git init`, write a default
 * .gitignore (only when absent), stage everything, then create an initial
 * commit. `--allow-empty` guarantees a base commit even when the folder is
 * empty or everything is ignored — Orca's worktree features need HEAD to point
 * at a real commit (an unborn HEAD breaks base-ref resolution).
 */
export async function initGitRepoInExistingFolder(ops: ConvertGitOps): Promise<ConvertGitResult> {
  let step: ConvertGitStep = 'init'
  try {
    await ops.exec(['init'])
    step = 'gitignore'
    if (!(await ops.hasGitignore())) {
      await ops.writeGitignore(DEFAULT_CONVERT_GITIGNORE)
    }
    step = 'stage'
    await ops.exec(['add', '-A'])
    step = 'commit'
    await ops.exec(['commit', '--allow-empty', '-m', CONVERT_INITIAL_COMMIT_MESSAGE])
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Identity config only matters at commit; init/add never ask "who are you".
    const isIdentityError = step === 'commit' && GIT_IDENTITY_HINT.test(message)
    return { ok: false, step, message, isIdentityError }
  }
}
