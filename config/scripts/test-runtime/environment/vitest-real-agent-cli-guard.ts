import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, afterEach } from 'vitest'

// Why: a test that inherits PATH can launch the developer's real agent CLI. A wrapper that never
// exits there (e.g. a version-manager shim that re-resolves itself) outlives the worker as an
// orphan loop, so stand-ins shadow those names and fail the test that reached them.
const AGENT_CLI_NAMES = [
  'amp',
  'auggie',
  'claude',
  'codex',
  'copilot',
  'crush',
  'cursor-agent',
  'droid',
  'gemini',
  'goose',
  'grok',
  'kimi',
  'omp',
  'opencode',
  'pi',
  'qwen'
]
// Real-agent opt-in suites intentionally run the installed CLIs.
const REAL_AGENT_CLI_SWITCHES = [
  'ORCA_REAL_CLAUDE_CLI_TEST',
  'ORCA_REAL_CLAUDE_SUPERVISED_STOP',
  'ORCA_CODEX_CONTRACT_BINARY',
  'ORCA_CODEX_NO_DAEMON_CONTRACT_BINARY',
  'ORCA_CODEX_TRUST_CONTRACT_BINARY',
  'ORCA_REPRO_CODEX_BINARY'
]

type GuardState = { dir: string; log: string }

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function install(): GuardState | null {
  if (process.platform === 'win32' || REAL_AGENT_CLI_SWITCHES.some((name) => process.env[name])) {
    return null
  }
  const dir = mkdtempSync(join(tmpdir(), 'orca-agent-cli-guard-'))
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const script = [
    '#!/bin/sh',
    // Discovery is expected in daemon tests; report the CLI as unavailable.
    'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then exit 127; fi',
    `printf '%s %s\\n' "\${0##*/}" "$*" >> ${quoteSh(log)}`,
    `echo "[vitest real-agent-cli guard] blocked real \${0##*/}; give the test its own stub on PATH" >&2`,
    'exit 127',
    ''
  ].join('\n')
  for (const name of AGENT_CLI_NAMES) {
    const path = join(dir, name)
    writeFileSync(path, script)
    chmodSync(path, 0o755)
  }
  process.env.PATH = process.env.PATH ? `${dir}${delimiter}${process.env.PATH}` : dir
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  return { dir, log }
}

declare global {
  // Install once per process; per-file installs would stack PATH entries.
  var orcaRealAgentCliGuard: GuardState | null | undefined
}
if (globalThis.orcaRealAgentCliGuard === undefined) {
  globalThis.orcaRealAgentCliGuard = install()
}
const state = globalThis.orcaRealAgentCliGuard

/** Drains recorded calls; only the guard's own self-test should need this. */
export function takeRealAgentCliCalls(): string[] {
  if (!state) {
    return []
  }
  let text = ''
  try {
    text = readFileSync(state.log, 'utf8')
    writeFileSync(state.log, '')
  } catch {
    return []
  }
  return text.split('\n').filter(Boolean)
}

function failOnCalls(): void {
  const calls = takeRealAgentCliCalls()
  if (calls.length > 0) {
    throw new Error(
      `[vitest real-agent-cli guard] test ran an agent CLI from the inherited PATH:\n${calls.join('\n')}`
    )
  }
}

afterEach(failOnCalls)
afterAll(failOnCalls)
