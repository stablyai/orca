// Generates the committed v9 audited-workflow database fixture (Phase 11 §1a).
//
// WHY A FIXTURE AT ALL. createAuditedWorkflowTables builds every table at its
// CURRENT shape, so a first-launch database is born at v10 and
// migrateAuditedWorkflowSchema returns immediately. Asserting `user_version = 10`
// on a fresh profile therefore exercises none of the migration code — it would
// pass even if migrateToV10 were deleted. Real users upgrade OVER an existing
// profile, and the installer smoke must reproduce that.
//
// WHY FROM GIT HISTORY. The v9 DDL is read out of the repository at the last
// commit before Phase 10 landed, so the fixture is a real v9 rather than a
// hand-written reconstruction that could drift from what actually shipped.
//
// DETERMINISM. Every id, timestamp, and SHA below is a fixed literal. No clock,
// no randomness, no host paths — so regenerating produces identical bytes and
// the committed file is reviewable.
//
// The fixture contains synthetic task metadata only: no real repository paths,
// no real SHAs, and no secrets.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = join(SCRIPT_DIR, '..', '..')
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'audited-workflow', 'v9')
const FIXTURE_PATH = join(FIXTURE_DIR, 'audited-workflow.db')

// The last commit BEFORE Phase 10 (14eb11558) — i.e. the tip of v9. Pinned as a
// literal so regeneration cannot silently follow a moving branch.
export const V9_SOURCE_COMMIT = '7aa18be23'
export const V9_SCHEMA_VERSION = 9

// Deterministic seed values, exported so the provenance test and the smoke
// assertions check the SAME literals rather than restating them.
export const V9_SEED = {
  committedTask: {
    id: 'task_v9_committed',
    state: 'committed',
    committedSha: 'c'.repeat(40),
    baseCommit: 'b'.repeat(40)
  },
  blockedTask: { id: 'task_v9_blocked', state: 'blocked' },
  // The sharp case: `landed` has been in the state CHECK since Phase 1, so a
  // pre-Phase-10 row can legitimately hold it — with landed_sha NULL, which is
  // exactly what the landed_sha_missing reconcile code exists to describe.
  landedTask: { id: 'task_v9_landed', state: 'landed', landedSha: null },
  commitAttempt: { id: 'catt_v9_1', status: 'completed', createdCommitSha: 'c'.repeat(40) },
  publishAttempt: { id: 'patt_v9_1', status: 'completed', pushedSha: 'c'.repeat(40) },
  candidate: { id: 'cand_v9_1', storeBytes: 4096 },
  transitionCount: 5
}

/** Reads a file as it existed at the pinned v9 commit. */
function readAtV9(relativePath) {
  return execFileSync('git', ['show', `${V9_SOURCE_COMMIT}:${relativePath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
}

/**
 * Extracts the v9 CREATE statements by executing the historical DDL modules'
 * SQL text directly.
 *
 * The schema modules are TypeScript and interpolate closed vocabularies into
 * their CHECK constraints, so rather than transpiling them we extract each
 * db.exec(`...`) template and substitute the vocabularies the same way the
 * source does. Any drift between this and the real v9 DDL surfaces immediately
 * in the provenance test, which asserts the resulting shape.
 */
function buildV9Ddl() {
  const schemaSource = readAtV9('src/main/audited-workflow/audited-task-schema.ts')
  const perPhaseModules = [
    'src/main/audited-workflow/audited-execution-schema.ts',
    'src/main/audited-workflow/audited-plan-review-schema.ts',
    'src/main/audited-workflow/audited-plan-coverage-schema.ts',
    'src/main/audited-workflow/audited-code-audit-schema.ts',
    'src/main/audited-workflow/audited-commit-schema.ts',
    'src/main/audited-workflow/audited-publish-schema.ts'
  ].map((path) => readAtV9(path))

  const vocabularies = loadV9Vocabularies()
  const statements = []
  for (const source of [schemaSource, ...perPhaseModules]) {
    for (const block of extractExecBlocks(source)) {
      // CREATION ONLY. The schema modules also contain the incremental
      // `ALTER TABLE ... ADD COLUMN` blocks that migrate a legacy database
      // forward; replaying those against a freshly-created v9 table would
      // duplicate columns that the CREATE already declared. A fresh v9 database
      // is exactly what createAuditedWorkflowTables produced at that commit.
      if (!/CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)/i.test(block)) {
        continue
      }
      statements.push(resolveVocabularies(block, vocabularies, source))
    }
  }
  return statements
}

/** Pulls every db.exec(`...`) template literal out of a schema module. */
function extractExecBlocks(source) {
  const blocks = []
  const marker = 'db.exec(`'
  let index = source.indexOf(marker)
  while (index !== -1) {
    const start = index + marker.length
    const end = source.indexOf('`)', start)
    if (end === -1) {
      break
    }
    blocks.push(source.slice(start, end))
    index = source.indexOf(marker, end)
  }
  return blocks
}

// Modules whose exported `const X = [...] as const` arrays the v9 schema
// interpolates into its CHECK constraints. Read from history rather than
// restated here: a hand-maintained copy would drift from what actually shipped,
// which is the exact failure mode this fixture exists to prevent.
const V9_VOCABULARY_MODULES = [
  'src/shared/audited-workflow-types.ts',
  'src/shared/audited-worktree-types.ts',
  'src/shared/audited-execution-types.ts',
  'src/shared/audited-plan-artifact-types.ts',
  'src/shared/audited-code-audit-types.ts',
  'src/shared/audited-commit-types.ts',
  'src/shared/audited-publish-types.ts'
]

/** Parses every `export const NAME = ['a', 'b'] as const` into a lookup. */
function loadV9Vocabularies() {
  const vocabularies = new Map()
  for (const modulePath of V9_VOCABULARY_MODULES) {
    let source
    try {
      source = readAtV9(modulePath)
    } catch {
      continue
    }
    const pattern = /export const ([A-Z0-9_]+) = \[([\s\S]*?)\] as const/g
    let match = pattern.exec(source)
    while (match !== null) {
      const values = [...match[2].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
      if (values.length > 0) {
        vocabularies.set(match[1], values)
      }
      match = pattern.exec(source)
    }
  }
  return vocabularies
}

// Maps the schema modules' local list names to the exported vocabulary each is
// built from, mirroring the `.map(...).join(', ')` lines in the v9 DDL.
//
// Only entries whose local name does not obviously derive from the vocabulary
// need listing; everything else is resolved by the declaration scan below, so a
// list this map has never heard of still gets its real v9 values rather than a
// silently-permissive placeholder.
const LIST_TO_VOCABULARY = {
  stateList: 'AUDITED_TASK_STATES',
  sourceList: 'TASK_SOURCES',
  riskList: 'RISK_LEVELS',
  actorList: 'TASK_ACTORS',
  triageDecisionList: 'TRIAGE_DECISIONS',
  triageRunStatusList: 'TRIAGE_RUN_STATUSES',
  triageReasonList: 'TRIAGE_REASON_CODES',
  attemptStatusList: 'WORKTREE_ATTEMPT_STATUSES',
  provenanceList: 'WORKTREE_PROVENANCE_KINDS',
  worktreeReasonList: 'WORKTREE_REASON_CODES',
  verdictList: 'REVIEW_VERDICTS',
  commitAttemptStatusList: 'COMMIT_ATTEMPT_STATUSES',
  publishAttemptStatusList: 'PUBLISH_ATTEMPT_STATUSES'
}

/**
 * Resolves a local `${xList}` name to its vocabulary by reading the schema
 * module's own `const xList = VOCABULARY.map(...)` declaration.
 *
 * This is what keeps the fixture honest for lists the map above does not name:
 * falling back to a permissive empty CHECK would let a seed row that the real
 * v9 schema would have REJECTED slip into the fixture.
 */
function resolveListFromDeclaration(source, listName, vocabularies) {
  const declaration = new RegExp(`const ${listName} = ([A-Z0-9_]+)`).exec(source)
  if (!declaration) {
    return null
  }
  return vocabularies.get(declaration[1]) ?? null
}

/**
 * Replaces interpolations with their v9 values.
 *
 * An unrecognized interpolation becomes a permissive empty literal rather than
 * failing the build: the fixture's purpose is migration SHAPE and row
 * preservation, and a loose CHECK cannot make the smoke assertions pass falsely
 * - they compare column presence and stored values, never constraints.
 */
function resolveVocabularies(block, vocabularies, source) {
  return block.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
    const listName = expression.trim()
    // DECLARATION FIRST, map second. The same local name (`statusList`,
    // `attemptStatusList`) is declared in more than one schema module from
    // DIFFERENT vocabularies, so a global map consulted first would silently
    // stamp one module's CHECK onto another's table.
    const mapped = LIST_TO_VOCABULARY[listName]
    const values =
      resolveListFromDeclaration(source, listName, vocabularies) ??
      (mapped ? vocabularies.get(mapped) : null)
    if (!values) {
      throw new Error(
        `Unresolved v9 CHECK vocabulary for \`${listName}\`. Add it to LIST_TO_VOCABULARY ` +
          `or ensure its module is listed in V9_VOCABULARY_MODULES — an unresolved list would ` +
          `produce a permissive CHECK and a fixture the real v9 schema would have rejected.`
      )
    }
    return values.map((value) => `'${value}'`).join(', ')
  })
}

function seedRows(db) {
  const task = (id, state, extra = {}) => {
    db.prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, source_repo_common_dir, base_commit, host_id,
          wsl_distro, title, spec_json, source, risk, state, branch_name, worktree_path,
          worktree_verified_at_ms, committed_sha, landed_sha, created_at_ms, updated_at_ms)
       VALUES (?, 'repo_v9', '/fixture/repo', '/fixture/repo/.git', ?, 'local', NULL, ?, '{}',
               'custom', 'low', ?, 'fixture-branch', '/fixture/wt', 1000, ?, ?, 1700000000000,
               1700000000000)`
    ).run(
      id,
      V9_SEED.committedTask.baseCommit,
      `Fixture ${state}`,
      state,
      extra.committedSha ?? null,
      extra.landedSha ?? null
    )
  }

  task(V9_SEED.committedTask.id, 'committed', {
    committedSha: V9_SEED.committedTask.committedSha
  })
  task(V9_SEED.blockedTask.id, 'blocked')
  // landed_sha stays NULL: the pre-Phase-10 reality.
  task(V9_SEED.landedTask.id, 'landed')

  db.prepare(
    `INSERT INTO audited_commit_attempts
       (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
        intended_message_sha, status, created_commit_sha, authorized_at_ms)
     VALUES (?, ?, 'appr_v9_1', ?, ?, 'fixture-branch', 'msgsha', ?, ?, 1700000001000)`
  ).run(
    V9_SEED.commitAttempt.id,
    V9_SEED.committedTask.id,
    'a'.repeat(40),
    V9_SEED.committedTask.baseCommit,
    V9_SEED.commitAttempt.status,
    V9_SEED.commitAttempt.createdCommitSha
  )

  db.prepare(
    `INSERT INTO audited_publish_attempts
       (id, task_id, commit_attempt_id, intended_sha, intended_branch, intended_remote,
        status, pushed_sha, authorized_at_ms)
     VALUES (?, ?, ?, ?, 'fixture-branch', 'origin', ?, ?, 1700000002000)`
  ).run(
    V9_SEED.publishAttempt.id,
    V9_SEED.committedTask.id,
    V9_SEED.commitAttempt.id,
    V9_SEED.committedTask.committedSha,
    V9_SEED.publishAttempt.status,
    V9_SEED.publishAttempt.pushedSha
  )

  db.prepare(
    `INSERT INTO audited_candidates
       (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name,
        store_bytes, created_at_ms)
     VALUES (?, ?, 'run_v9_1', 0, 'current', ?, ?, 'fixture-branch', ?, 1700000003000)`
  ).run(
    V9_SEED.candidate.id,
    V9_SEED.committedTask.id,
    'a'.repeat(40),
    V9_SEED.committedTask.baseCommit,
    V9_SEED.candidate.storeBytes
  )

  const transitions = [
    [V9_SEED.committedTask.id, null, 'selected', 'human', 'select'],
    [V9_SEED.committedTask.id, 'selected', 'triaging', 'control', 'triage'],
    [V9_SEED.committedTask.id, 'committing', 'committed', 'control', 'commit_complete'],
    [V9_SEED.blockedTask.id, 'implementing', 'blocked', 'control', 'implement_block'],
    [V9_SEED.landedTask.id, 'landing', 'landed', 'control', 'land_complete']
  ]
  for (const [taskId, from, to, actor, eventType] of transitions) {
    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 1700000004000)`
    ).run(taskId, from, to, actor, eventType)
  }
}

export function generateV9Fixture(targetPath = FIXTURE_PATH) {
  mkdirSync(dirname(targetPath), { recursive: true })
  rmSync(targetPath, { force: true })

  const db = new DatabaseSync(targetPath)
  try {
    for (const statement of buildV9Ddl()) {
      db.exec(statement)
    }
    seedRows(db)
    db.exec(`PRAGMA user_version = ${V9_SCHEMA_VERSION}`)
  } finally {
    db.close()
  }
  return targetPath
}

function writeReadme() {
  const readme = `# v9 audited-workflow fixture

**Generated. Do not hand-edit.** Regenerate with:

\`\`\`sh
node config/scripts/generate-audited-v9-fixture.mjs
\`\`\`

## What it is

A schema-version **9** \`audited-workflow.db\` — the last shape before Phase 10
added the landing lane. The installer smoke copies it into an isolated
packaged-userData directory and asserts the app migrates it to **v10** with every
seeded row intact.

## Why it exists

\`createAuditedWorkflowTables\` builds every table at its current shape, so a
first-launch database is born at v10 and the migration is a no-op. Observing
\`user_version = 10\` on a fresh profile would pass even if \`migrateToV10\` were
deleted. Real users upgrade over an existing profile; this fixture reproduces
that.

## Provenance

The DDL is read out of the repository at commit \`${V9_SOURCE_COMMIT}\` — the last
commit before Phase 10 — so the fixture is a real v9 rather than a
reconstruction that could drift from what shipped.

## Contents

Synthetic metadata only. No real repository paths, no real SHAs, no secrets.
Every id, timestamp, and SHA is a fixed literal, so regeneration is
byte-reproducible.

| Table | Rows |
| --- | --- |
| \`audited_tasks\` | 3 — \`committed\` (with \`committed_sha\`), \`blocked\`, \`landed\` (with \`landed_sha\` NULL) |
| \`audited_commit_attempts\` | 1 \`completed\`, bound to the committed SHA |
| \`audited_publish_attempts\` | 1 \`completed\` with \`pushed_sha\` |
| \`audited_candidates\` | 1 with \`store_bytes\` non-NULL |
| \`audited_transitions\` | ${V9_SEED.transitionCount} |

\`tests/fixtures/audited-workflow/v9/audited-workflow.db\` is **read-only** to
consumers: the harness copies it, never opens it in place.
`
  writeFileSync(join(FIXTURE_DIR, 'README.md'), readme, 'utf8')
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('generate-audited-v9-fixture.mjs')
if (invokedDirectly) {
  const path = generateV9Fixture()
  writeReadme()
  console.log(`Wrote v9 fixture: ${path}`)
}
