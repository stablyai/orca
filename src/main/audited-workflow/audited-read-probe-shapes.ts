// Arity screens for every audited subcommand that is admissible ONLY in one exact
// form: Phase 9's read-only remote topology and Phase 10's source-repo readiness
// probes.
//
// In its own module because audited-worktree-commands.ts (which applies the
// screens) and audited-land-commands.ts (which builds the argv) would otherwise
// form an import cycle — and because that file is at its max-lines budget.
//
// All four are genuinely read-only once screened, so they run on the existing
// runAuditedGitRead path rather than any write path.
export class AuditedGitProbeShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditedGitProbeShapeError'
  }
}

// Phase 10's two subcommands. Kept separate so the land READ probes and the land
// WRITE commands can be told apart structurally rather than by convention.
export const LAND_READ_SUBCOMMANDS = new Set(['status', 'diff-index'])

/**
 * Screens every exact-form subcommand. A no-op for anything else.
 *
 * `config` — exactly `config --get <key>`; any other form could WRITE config.
 * `remote` — exactly the bare listing form; `remote update` reaches the network
 *   and `remote add|set-url|remove` mutates configuration.
 * `status` — exactly `status --porcelain`; other forms recurse into submodules or
 *   trigger an index-refresh write, and `-uall`/`--ignored` change what "clean"
 *   means, so the readiness check must have exactly one definition.
 * `diff-index` — exactly `diff-index --quiet <tree-ish> --`; the trailing `--` is
 *   what keeps a pathspec out, since without it the operand could be
 *   reinterpreted as a path.
 */
export function assertReadProbeShape(argv: readonly string[], subcommand: string | null): void {
  if (subcommand === 'config') {
    const rest = argv.slice(argv.indexOf('config'))
    if (rest.length !== 3 || rest[1] !== '--get') {
      throw new AuditedGitProbeShapeError('audited config must be exactly `config --get <key>`')
    }
    return
  }
  if (subcommand === 'remote') {
    if (argv.slice(argv.indexOf('remote')).length !== 1) {
      throw new AuditedGitProbeShapeError('audited remote must be the bare listing form')
    }
    return
  }
  if (subcommand === 'status') {
    const rest = argv.slice(argv.indexOf('status'))
    if (rest.length !== 2 || rest[1] !== '--porcelain') {
      throw new AuditedGitProbeShapeError('audited status must be exactly `status --porcelain`')
    }
    return
  }
  if (subcommand === 'diff-index') {
    const rest = argv.slice(argv.indexOf('diff-index'))
    if (rest.length !== 4 || rest[1] !== '--quiet' || rest[3] !== '--') {
      throw new AuditedGitProbeShapeError(
        'audited diff-index must be exactly `diff-index --quiet <tree-ish> --`'
      )
    }
  }
}

/**
 * Exactly `rev-list --count <range>` — the ancestry probe, never the object
 * enumerator.
 *
 * Screened by arity so `--objects` (which enumerates the graph and needs the
 * candidate store attached via GIT_OBJECT_DIRECTORY) can never satisfy it,
 * whatever order the flags arrive in. Phase 8's commit evidence and Phase 10's
 * tip classification both depend on the counting form reaching the read path.
 */
export function isRevListCountArgv(argv: readonly string[]): boolean {
  const index = argv.indexOf('rev-list')
  if (index === -1) {
    return false
  }
  const rest = argv.slice(index)
  return rest.length === 3 && rest[1] === '--count'
}
