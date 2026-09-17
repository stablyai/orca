/**
 * Guards the two claims `mobile/rpc-foundation/goldens` makes about its pin.
 *
 * `ancestry`  — `baseline` names a commit in this history. A behaviour-change branch pins its own
 *               last fenced commit; that commit stops being reachable the moment the branch
 *               squash-merges, and nobody can run `--record` on main again until a hand-made repin
 *               lands. Ordinary product drift past a reachable pin is normal and is not a failure.
 * `reproduce` — the goldens on disk are what the recorder produces from the PINNED tree. The
 *               recording suites replay the corpus against the CURRENT tree on every run, which is
 *               the same claim only while the fenced tree still matches the pin.
 */
import { createRequire } from 'node:module'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process.ts'
import { RECORDING_DRIVERS } from '../src/test-support/rpc-recording/recording-drivers.ts'
import { readScenarios } from '../src/test-support/rpc-recording/scenario-input.ts'

/** The recorder is exempt from the fence, so a reproduction lays the candidate copy over the pin. */
export const RECORDER_OVERLAY = 'mobile/src/test-support/rpc-recording'
/**
 * Everything a reproduction takes from the candidate tree rather than from the pin: the corpus it
 * compares against, the manifest that names the pin and derives the scenarios, and the recorder it
 * lays over the pinned sources. A revision that moves none of these cannot move the verdict, which
 * is what lets a pull request skip the run.
 */
export const CORPUS_PROVENANCE_PATHS = ['mobile/rpc-foundation', RECORDER_OVERLAY] as const
/**
 * The corpus readers that are not drivers. Boundary: every suite that resolves its directory from
 * `RPC_FOUNDATION_GOLDENS` runs here, so the pinned-tree run makes the whole claim. `derived-goldens`
 * is the census a whole golden spliced in by a merge trips, which no per-golden compare can see.
 */
const CORPUS_CENSUS_SUITES = [
  'derived-goldens.test.ts',
  'golden-recorder-failure-absence.test.ts'
] as const
const RECORDING_TIMEOUT_MS = 900_000
// A failing reproduction prints one diff per golden; 8 MB clips that mid-report.
const RECORDING_OUTPUT_BYTES = 64 * 1024 * 1024

export type PinAncestryFailure = 'shallow' | 'unreachable' | 'not-an-ancestor'
export type PinAncestryVerdict =
  | { ok: true; baseline: string; ref: string }
  | { ok: false; baseline: string; ref: string; failure: PinAncestryFailure; message: string }

async function git(cwd: string, args: readonly string[]) {
  return await runProcess({ program: 'git', args: [...args], cwd })
}
export function readPinnedBaseline(root: string): string {
  return readScenarios(resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')).baseline
}
export function repinInstruction(baseline: string, ref: string, cause: string): string {
  return [
    `The RPC recording corpus is pinned to a commit that ${cause}.`,
    '',
    `  baseline  ${baseline}   (mobile/rpc-foundation/pilot-scenarios.json)`,
    `  head      ${ref}`,
    '',
    'Every golden under mobile/rpc-foundation/goldens claims it was recorded from that tree, and',
    '`--record` refuses on any other tree, so the corpus cannot be refreshed until the pin names a',
    'commit that is reachable from here. Repin and re-record, both in one commit:',
    '',
    `  git switch -c repin-rpc-recording ${ref}`,
    `  # set "baseline" in mobile/rpc-foundation/pilot-scenarios.json to ${ref}`,
    '  ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 \\',
    '    pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record',
    '',
    'Re-record everything: the repin rewrites the `baseline` header of every golden, so a partial',
    'refresh leaves the corpus pinned to two different trees. See',
    'mobile/src/test-support/rpc-recording/README.md, "Recording a behaviour change".'
  ].join('\n')
}
const SHALLOW_MESSAGE = [
  'Cannot judge the recording pin: this is a shallow clone.',
  '',
  '`git merge-base --is-ancestor` answers from grafted history, so it would report a verdict this',
  'guard has no evidence for. Check out with `fetch-depth: 0`.'
].join('\n')

export async function checkPinAncestry(
  root: string,
  baseline: string,
  ref: string
): Promise<PinAncestryVerdict> {
  const shallow = await git(root, ['rev-parse', '--is-shallow-repository'])
  if (shallow.code !== 0) {
    throw new Error(`Could not ask git whether the clone is shallow: ${shallow.stderr.trim()}`)
  }
  if (shallow.stdout.trim() !== 'false') {
    return { ok: false, baseline, ref, failure: 'shallow', message: SHALLOW_MESSAGE }
  }
  const head = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (head.code !== 0) {
    throw new Error(`Cannot resolve ${ref} to a commit in this repository`)
  }
  // Resolved, because the instruction below is a command to paste: `HEAD` in it moves with whatever
  // the reader has checked out by the time they read the log.
  const resolved = head.stdout.trim()
  const pinned = await git(root, ['rev-parse', '--verify', '--quiet', `${baseline}^{commit}`])
  if (pinned.code !== 0) {
    return {
      ok: false,
      baseline,
      ref,
      failure: 'unreachable',
      message: repinInstruction(baseline, resolved, 'is not a commit in this repository at all')
    }
  }
  const ancestor = await git(root, ['merge-base', '--is-ancestor', baseline, ref])
  if (ancestor.code === 0) {
    return { ok: true, baseline, ref }
  }
  // Why only 1: git reserves higher codes for real errors, and treating one as "not an ancestor"
  // would turn a broken repository into a repin instruction nobody can act on.
  if (ancestor.code !== 1) {
    throw new Error(`git merge-base --is-ancestor failed: ${ancestor.stderr.trim()}`)
  }
  return {
    ok: false,
    baseline,
    ref,
    failure: 'not-an-ancestor',
    message: repinInstruction(baseline, resolved, 'is not an ancestor of this commit')
  }
}

/** Whether anything a reproduction reads from the candidate tree moved since `since`. */
export async function corpusProvenanceChanged(root: string, since: string): Promise<boolean> {
  // The branch point, not the base tip: a base that moved on without this branch would otherwise
  // read as this branch's change and buy a run whose verdict the base push already published.
  const branchPoint = await git(root, ['merge-base', since, 'HEAD'])
  const from = branchPoint.code === 0 ? branchPoint.stdout.trim() : since
  const diff = await git(root, ['diff', '--quiet', from, '--', ...CORPUS_PROVENANCE_PATHS])
  if (diff.code !== 0 && diff.code !== 1) {
    throw new Error(`Could not diff the corpus against ${from}: ${diff.stderr.trim()}`)
  }
  return diff.code === 1
}

/**
 * Replay the corpus against the pinned tree instead of the current one: check the pin out detached,
 * lay this tree's recorder and manifest over it (both exempt from the fence, and both are what the
 * goldens pin by digest rather than by commit), and let the recording suites compare in place. The
 * comparison is `compareGolden`, so lockfile and platform stay masked the way they are on every
 * other run.
 */
export async function reproduceFromPin(root: string, baseline: string): Promise<boolean> {
  const scratch = await mkdtemp(join(tmpdir(), 'rpc-recording-pin-'))
  const tree = join(scratch, 'tree')
  try {
    const added = await git(root, ['worktree', 'add', '--detach', tree, baseline])
    if (added.code !== 0) {
      throw new Error(`Could not check out the pinned tree ${baseline}: ${added.stderr.trim()}`)
    }
    await symlink(resolve(root, 'node_modules'), join(tree, 'node_modules'))
    await symlink(resolve(root, 'mobile/node_modules'), join(tree, 'mobile/node_modules'))
    await rm(join(tree, RECORDER_OVERLAY), { recursive: true, force: true })
    await cp(resolve(root, RECORDER_OVERLAY), join(tree, RECORDER_OVERLAY), { recursive: true })
    const require = createRequire(resolve(root, 'mobile/package.json'))
    const result = await runProcess({
      program: process.execPath,
      args: [
        resolve(require.resolve('vitest/package.json'), '../vitest.mjs'),
        'run',
        ...[...RECORDING_DRIVERS, ...CORPUS_CENSUS_SUITES].map(
          (suite) => `src/test-support/rpc-recording/${suite}`
        )
      ],
      cwd: join(tree, 'mobile'),
      timeoutMs: RECORDING_TIMEOUT_MS,
      maxOutputBytes: RECORDING_OUTPUT_BYTES,
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        // Replay, never `--record`: the suites read these two from the candidate tree and compare.
        RPC_FOUNDATION_GOLDENS: resolve(root, 'mobile/rpc-foundation/goldens'),
        RPC_FOUNDATION_SCENARIOS: resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
      }
    })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    if (result.outputTruncated) {
      process.stderr.write('\nReproduction output was clipped; the report above is incomplete.\n')
    }
    if (result.timedOut) {
      throw new Error(
        `Reproducing the corpus did not finish within ${RECORDING_TIMEOUT_MS / 1000}s and was killed.`
      )
    }
    return result.code === 0
  } finally {
    await git(root, ['worktree', 'remove', '--force', tree])
    await git(root, ['worktree', 'prune'])
    await rm(scratch, { recursive: true, force: true })
  }
}

export const REPRODUCTION_FAILURE = [
  'The goldens on disk are not what the recorder produces from the pinned tree.',
  '',
  'Each divergence above is a golden whose header names a tree that does not produce it. A merge',
  'that auto-merged golden JSON, or a refresh recorded somewhere other than the pin, both land',
  'here. Re-record the whole corpus from the pin rather than editing a golden:',
  '',
  '  ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 \\',
  '    pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record'
].join('\n')

async function main(argv: readonly string[]): Promise<void> {
  const check = argv[0]
  const root = resolve(import.meta.dirname, '../..')
  const baseline = readPinnedBaseline(root)
  if (check === 'ancestry') {
    const ref = argv.includes('--ref') ? argv[argv.indexOf('--ref') + 1] : 'HEAD'
    if (!ref) {
      throw new Error('--ref needs a commit')
    }
    const verdict = await checkPinAncestry(root, baseline, ref)
    if (!verdict.ok) {
      process.stderr.write(`${verdict.message}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`Recording pin ${baseline} is an ancestor of ${ref}.\n`)
    return
  }
  if (check === 'reproduce') {
    const since = argv.includes('--if-changed-since')
      ? argv[argv.indexOf('--if-changed-since') + 1]
      : undefined
    if (argv.includes('--if-changed-since')) {
      if (!since) {
        throw new Error('--if-changed-since needs a commit')
      }
      if (!(await corpusProvenanceChanged(root, since))) {
        process.stdout.write(
          `Nothing this run reads from the working tree moved since ${since}: not the corpus, not\nthe manifest, not the recorder. The verdict is the one that commit already carries.\n`
        )
        return
      }
    }
    if (!(await reproduceFromPin(root, baseline))) {
      process.stderr.write(`\n${REPRODUCTION_FAILURE}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`\nThe corpus reproduces from the pinned tree ${baseline}.\n`)
    return
  }
  throw new Error(
    'Usage: rpc-recording-pin-guard.mts ancestry [--ref <commit>]\n     | reproduce [--if-changed-since <commit>]'
  )
}

// Importing this module for its verdicts must not run a check; the unit test beside it does that.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main(process.argv.slice(2))
}
