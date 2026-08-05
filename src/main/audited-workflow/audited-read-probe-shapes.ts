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
 * Every subcommand that is READ-ONLY once screened to its exact form(s) below.
 *
 * One set rather than one per phase: the read path asks a single question — "is
 * this argv read-only?" — and for all of these the answer is yes for the SAME
 * reason, namely that assertReadProbeShape has already pinned the form.
 *
 * Membership is MEANINGLESS WITHOUT THAT SCREEN: a bare `diff-tree` carrying
 * `--ext-diff` or `--textconv` runs an external command from repository config.
 * This set may only be consulted after assertAuditedGitArgvShape has run.
 */
export const EXACT_FORM_READ_SUBCOMMANDS = new Set([...LAND_READ_SUBCOMMANDS, 'diff-tree'])

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
    return
  }
  if (subcommand === 'diff-tree') {
    assertDiffTreeShape(argv)
  }
}

/**
 * The audit bundle's two diff forms, both exact.
 *
 * `diff-tree -r --stat <a> <b> --`  — the change summary
 * `diff-tree -r --patch <a> <b> --` — the unified diff
 *
 * Both operands must be full OIDs, so a ref name, a range expression, or a
 * `--output=<path>` cannot enter. The trailing `--` keeps a pathspec out, and
 * the fixed length is what stops `--ext-diff` or `--textconv` — either of which
 * would run an EXTERNAL COMMAND from repository config, turning a read probe
 * into arbitrary execution.
 */
const FULL_OID = /^[0-9a-f]{40}$/

function assertDiffTreeShape(argv: readonly string[]): void {
  const rest = argv.slice(argv.indexOf('diff-tree'))
  const shapeIsValid =
    rest.length === 6 &&
    rest[1] === '-r' &&
    (rest[2] === '--stat' || rest[2] === '--patch') &&
    FULL_OID.test(rest[3] ?? '') &&
    FULL_OID.test(rest[4] ?? '') &&
    rest[5] === '--'
  if (!shapeIsValid) {
    throw new AuditedGitProbeShapeError(
      'audited diff-tree must be exactly `diff-tree -r --stat|--patch <oid> <oid> --`'
    )
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
