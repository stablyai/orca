#!/usr/bin/env node
// Compare stdout/stderr/exit byte-for-byte across two real CLI emits: current tree and selected files restored from baseline (default HEAD~).
// Full-tree compilation stays outside fast Vitest invariants (runtime-client-deferral.test.ts).
// Usage: node config/scripts/cli-runtime-client-deferral-equivalence.mjs [--baseline <rev>]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

// Restore only these baseline files; remove baseline-absent files (e.g. cli-error.ts), then restore the working tree.
const TOUCHED = [
  'src/cli/args.ts',
  'src/cli/cli-error.ts',
  'src/cli/dispatch.ts',
  'src/cli/flags.ts',
  'src/cli/format.ts',
  'src/cli/index.ts',
  'src/cli/runtime/client.ts',
  'src/cli/selectors.ts'
]

// Fail if real deferral call shapes change or baseline/current could become identical and pass vacuously.
function assertMarkersFresh() {
  const index = readFileSync(join(REPO, 'src/cli/index.ts'), 'utf8')
  const client = readFileSync(join(REPO, 'src/cli/runtime/client.ts'), 'utf8')
  const checks = [
    ['src/cli/index.ts', index, 'await loadRuntimeClientClass()'],
    ['src/cli/index.ts', index, "await import('./runtime-client.js')"],
    ['src/cli/index.ts', index, "import type { RuntimeClient } from './runtime-client'"],
    ['src/cli/runtime/client.ts', client, 'await loadSendWebSocketRequest()'],
    ['src/cli/runtime/client.ts', client, "await import('./websocket-transport.js')"]
  ]
  for (const [file, source, marker] of checks) {
    // Match calls so prose mentions cannot satisfy the guard.
    if (!source.includes(marker)) {
      throw new Error(
        `${file} no longer contains \`${marker}\` — cli-runtime-client-deferral-equivalence.mjs is stale`
      )
    }
  }
  const repointed = ['src/cli/args.ts', 'src/cli/flags.ts', 'src/cli/dispatch.ts']
  for (const file of repointed) {
    const source = readFileSync(join(REPO, file), 'utf8')
    if (!source.includes("import { RuntimeClientError } from './runtime/types'")) {
      throw new Error(`${file} no longer repoints RuntimeClientError at ./runtime/types — stale`)
    }
  }
}

function buildTree(label, baselineRev) {
  // Build inside repo so emitted modules resolve its node_modules.
  const outDir = join(REPO, `.equiv-out-${label}`)
  rmSync(outDir, { recursive: true, force: true })
  const restored = []
  try {
    if (baselineRev) {
      for (const file of TOUCHED) {
        const path = join(REPO, file)
        restored.push([path, existsSync(path) ? readFileSync(path) : null])
        const old = spawnSync('git', ['show', `${baselineRev}:${file}`], {
          cwd: REPO,
          maxBuffer: 64 * 1024 * 1024
        })
        if (old.status === 0) {
          writeFileSync(path, old.stdout)
        } else {
          rmSync(path, { force: true })
        }
      }
    }
    execFileSync(
      'npx',
      [
        'tsc',
        '-p',
        'config/tsconfig.cli.json',
        '--outDir',
        outDir,
        '--composite',
        'false',
        '--incremental',
        'false'
      ],
      { cwd: REPO, stdio: 'inherit' }
    )
  } finally {
    for (const [path, contents] of restored) {
      if (contents === null) {
        rmSync(path, { force: true })
      } else {
        writeFileSync(path, contents)
      }
    }
  }
  return join(outDir, 'cli/index.js')
}

// Every case must exit itself; bound spawnSync so reaching a blocking command fails instead of stalling forever.
const RUN_TIMEOUT_MS = 30_000

function run(entry, argv, env) {
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'buffer',
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  })
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        `orca ${argv.join(' ')} did not exit within ${RUN_TIMEOUT_MS} ms — it reached a blocking command`
      )
    }
    throw result.error
  }
  return {
    status: result.status,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8')
  }
}

// Require identical bytes; empty user-data dirs make runtime-dependent cases deterministically report not running.
function buildCases(isolatedUserData) {
  const isolated = { ORCA_USER_DATA_PATH: isolatedUserData }
  const cases = [
    // Paths that must never load the runtime client at all.
    [[], {}],
    [['--help'], {}],
    [['help'], {}],
    [['help', 'worktree'], {}],
    [['help', 'browser'], {}],
    [['worktree', '--help'], {}],
    [['help', 'no-such-command'], {}],
    [['no-such-command'], {}],
    [['no-such-command'], { ORCA_PAIRING_CODE: 'garbage' }],
    [['wrktree', 'list'], {}],
    [['agent-context'], {}],
    [['agent-context', '--json'], {}],
    // Flag validation must still fire before any runtime lookup.
    [['worktree', 'list', '--nonexistent-flag'], {}],
    [['worktree', 'list', '--nonexistent-flag', '--json'], {}],
    [['browser', 'snapshot', '--nonexistent-flag'], {}],
    // resolveRemotePairing throws from the RuntimeClient CONSTRUCTOR.
    [['status', '--pairing-code', 'x', '--environment', 'y'], isolated],
    [['status', '--pairing-code', 'x', '--environment', 'y', '--json'], isolated],
    [['status', '--pairing-code', 'not-a-pairing-code'], isolated],
    [['status', '--pairing-code', 'not-a-pairing-code', '--json'], isolated],
    [['status', '--pairing-code', 'orca://pair?code=zzzz'], isolated],
    [['status', '--environment', 'no-such-environment'], isolated],
    [['status', '--environment', 'no-such-environment', '--json'], isolated],
    [['worktree', 'list', '--environment', 'no-such-environment', '--json'], isolated],
    // The env-var fallback must stay live for non-suppressed commands...
    [['status', '--json'], { ...isolated, ORCA_PAIRING_CODE: 'not-a-pairing-code' }],
    [['status', '--json'], { ...isolated, ORCA_REMOTE_PAIRING: 'not-a-pairing-code' }],
    [['status', '--json'], { ...isolated, ORCA_ENVIRONMENT: 'no-such-environment' }],
    // Keep suppression for local-only groups. Do not invoke agent hooks on/off: they modify real ~/.claude configuration outside ORCA_USER_DATA_PATH.
    // Constructor-argument assertions in runtime-client-deferral.test.ts cover null/undefined suppression without those side effects.
    [['environment', 'list', '--json'], { ...isolated, ORCA_ENVIRONMENT: 'no-such-environment' }],
    [['environment', 'list', '--json'], { ...isolated, ORCA_PAIRING_CODE: 'not-a-pairing-code' }],
    [['agent-context', '--json'], { ...isolated, ORCA_PAIRING_CODE: 'not-a-pairing-code' }],
    // Runtime-unavailable reporting (RuntimeClientError formatting).
    [['status'], isolated],
    [['status', '--json'], isolated],
    [['worktree', 'list', '--json'], isolated],
    [['terminal', 'list', '--json'], isolated]
  ]
  // Seed fuzzing for reproducibility; all pool tokens must be safe to execute, checked against UNSAFE_TOKENS before running any case.
  const tokens = [
    'worktree',
    'list',
    'status',
    'browser',
    'snapshot',
    'terminal',
    'environment',
    'agent',
    'agent-context',
    'vm',
    '--json',
    '--help',
    '--pairing-code',
    '--environment',
    '--worktree',
    'orca://pair?code=!!!',
    '',
    '-',
    '--',
    '--=',
    'a'.repeat(300),
    'näme-ünicode',
    '💥',
    '../..',
    'x\ty'
  ]
  let seed = 0x9e3779b9
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x100000000
  }
  // Check entire pool, not just sampled cases: serve once survived review here and escaped the per-case scan by chance.
  assertTokensSafe(tokens, 'fuzz token pool')
  assertFuzzPoolDeclaredReadOnly(tokens)
  for (let index = 0; index < 400; index += 1) {
    const length = 1 + Math.floor(next() * 4)
    const argv = []
    for (let part = 0; part < length; part += 1) {
      argv.push(tokens[Math.floor(next() * tokens.length)])
    }
    cases.push([argv, isolated])
  }
  for (const [argv] of cases) {
    assertTokensSafe(argv, `argv ${JSON.stringify(argv)}`)
  }
  return cases
}

// Cases run real CLI with developer HOME/PATH: deny foreground commands, surviving children, config/registry writes and real UI input.
// Deny mixed read/write groups (capture/intercept/label/relation) wholesale; fuzzing cannot distinguish their subcommands.
const FOREGROUND_TOKENS = ['serve', 'open', 'claude-teams', 'exec', 'eval', 'launch', 'attach']
const MUTATING_TOKENS = [
  // persistent config and registry state
  'on',
  'off',
  'hooks',
  'create',
  'remove',
  'rm',
  'delete',
  'add',
  'edit',
  'set',
  'set-value',
  'set-base-ref',
  'setup-clone',
  'setup-create',
  'setup-update',
  'setup-delete',
  'setup-existing-folder',
  'install',
  'uninstall',
  'reinstall',
  'update',
  'clone',
  'apply',
  'write',
  'reset',
  'clear',
  'enable',
  'disable',
  'use-default',
  'permissions',
  // process and pane lifecycle
  'run',
  'run-stop',
  'start',
  'stop',
  'kill',
  'shutdown',
  'close',
  'split',
  'switch',
  'rename',
  'focus',
  // orchestration writes
  'send',
  'reply',
  'dispatch',
  'task-create',
  'task-update',
  'gate-create',
  'gate-resolve',
  // issue-tracker writes
  'save-issue',
  'comment',
  'label',
  'relation',
  'assignee',
  'priority',
  'estimate',
  'due-date',
  // browser / computer / emulator input and navigation
  'goto',
  'back',
  'forward',
  'reload',
  'click',
  'dblclick',
  'hover',
  'fill',
  'type',
  'type-text',
  'select',
  'select-all',
  'uncheck',
  'keypress',
  'press-key',
  'inserttext',
  'hotkey',
  'paste-text',
  'perform-secondary-action',
  'drag',
  'scroll',
  'scrollintoview',
  'wheel',
  'move',
  'up',
  'down',
  'tap',
  'gesture',
  'button',
  'rotate',
  'upload',
  'download',
  'dismiss',
  'accept',
  'highlight',
  'viewport',
  'geolocation',
  'headers',
  'credentials',
  'offline',
  'media',
  'device',
  'capture',
  'intercept'
]

const UNSAFE_TOKENS = new Map([
  ...FOREGROUND_TOKENS.map((token) => [token, 'runs in the foreground or spawns a process']),
  ...MUTATING_TOKENS.map((token) => [token, 'can write outside ORCA_USER_DATA_PATH'])
])

// Deny lists miss new verbs (serve once escaped); require explicit read-only allowlisting for every pool token too.
const READ_ONLY_FUZZ_TOKENS = new Set([
  // command tokens: every path they can form is a list/show or a parse error
  'agent',
  'agent-context',
  'browser',
  'environment',
  'list',
  'snapshot',
  'status',
  'terminal',
  'vm',
  'worktree',
  // global flags and hostile strings, which reach no handler at all
  '--json',
  '--help',
  '--pairing-code',
  '--environment',
  '--worktree',
  'orca://pair?code=!!!',
  '',
  '-',
  '--',
  '--=',
  'a'.repeat(300),
  'näme-ünicode',
  '💥',
  '../..',
  'x\ty'
])

function assertTokensSafe(tokens, context) {
  for (const token of tokens) {
    const reason = UNSAFE_TOKENS.get(token)
    if (reason) {
      throw new Error(`Refusing to run ${context}: "${token}" ${reason}`)
    }
  }
}

// Reject neither/both-list membership before any case runs; sampling cannot prove pool safety.
function assertFuzzPoolDeclaredReadOnly(tokens) {
  for (const token of tokens) {
    if (!READ_ONLY_FUZZ_TOKENS.has(token)) {
      throw new Error(
        `Fuzz token ${JSON.stringify(token)} is not declared in READ_ONLY_FUZZ_TOKENS — declare it read-only or drop it`
      )
    }
  }
  for (const token of READ_ONLY_FUZZ_TOKENS) {
    if (UNSAFE_TOKENS.has(token)) {
      throw new Error(
        `Token ${JSON.stringify(token)} is declared both read-only and unsafe — the two lists disagree`
      )
    }
  }
}

const baselineIndex = process.argv.indexOf('--baseline')
const baselineRev = baselineIndex === -1 ? 'HEAD' : process.argv[baselineIndex + 1]

assertMarkersFresh()

const isolatedUserData = mkdtempSync(join(REPO, '.equiv-userdata-'))
mkdirSync(join(isolatedUserData, 'empty'), { recursive: true })

let oldEntry
let newEntry
try {
  // Build cases and check safety before expensive tsc compiles so unsafe tokens fail immediately.
  const cases = buildCases(isolatedUserData)

  console.log(`Building baseline (${baselineRev}) …`)
  oldEntry = buildTree('old', baselineRev)
  console.log('Building working tree …')
  newEntry = buildTree('new', null)

  console.log(`Comparing ${cases.length} invocations byte for byte …`)
  let mismatches = 0
  for (const [argv, env] of cases) {
    const before = run(oldEntry, argv, env)
    const after = run(newEntry, argv, env)
    if (
      before.status !== after.status ||
      before.stdout !== after.stdout ||
      before.stderr !== after.stderr
    ) {
      mismatches += 1
      console.error(`\nMISMATCH argv=${JSON.stringify(argv)} env=${JSON.stringify(env)}`)
      console.error(`  exit   before=${before.status} after=${after.status}`)
      if (before.stdout !== after.stdout) {
        console.error(`  stdout before=${JSON.stringify(before.stdout.slice(0, 400))}`)
        console.error(`         after =${JSON.stringify(after.stdout.slice(0, 400))}`)
      }
      if (before.stderr !== after.stderr) {
        console.error(`  stderr before=${JSON.stringify(before.stderr.slice(0, 400))}`)
        console.error(`         after =${JSON.stringify(after.stderr.slice(0, 400))}`)
      }
    }
  }
  if (mismatches > 0) {
    throw new Error(`${mismatches} of ${cases.length} invocations differ`)
  }
  console.log(`\nAll ${cases.length} invocations byte-identical (stdout, stderr, exit code).`)
} finally {
  rmSync(isolatedUserData, { recursive: true, force: true })
  for (const label of ['old', 'new']) {
    rmSync(resolve(REPO, `.equiv-out-${label}`), { recursive: true, force: true })
  }
}
