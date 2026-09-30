import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODEX_SHARED_SERVER_ARGS } from '../../shared/codex-shell-function'

// Why: Orca's codex shell wrapper puts --no-daemon first for every subcommand but
// agents/queue (src/shared/codex-shell-function.ts). Its tests use a fake codex, so
// only the real binary can catch a renamed flag or a new subcommand rejecting it.

const execFileAsync = promisify(execFile)
const binary = process.env.ORCA_CODEX_NO_DAEMON_CONTRACT_BINARY
const expectedVersion = process.env.ORCA_CODEX_NO_DAEMON_CONTRACT_VERSION
const WRAPPER_SKIPPED_SUBCOMMANDS: ReadonlySet<string> = new Set(CODEX_SHARED_SERVER_ARGS)
const TIMEOUT_MS = 30_000

describe.runIf(process.env.ORCA_CODEX_NO_DAEMON_CONTRACT_REQUIRED === '1' && !binary)(
  'codex --no-daemon contract prerequisites',
  () => {
    it('was given a Codex binary to run against', () => {
      expect.fail('ORCA_CODEX_NO_DAEMON_CONTRACT_REQUIRED=1 but no binary was given')
    })
  }
)

describe.runIf(binary)('codex --no-daemon binary contract', { timeout: 120_000 }, () => {
  let home: string
  let help: string

  beforeAll(async () => {
    // Why a disposable home: never read or start anything under the user's ~/.codex.
    home = mkdtempSync(join(tmpdir(), 'orca-codex-no-daemon-contract-'))
    const version = await run(['--version'])
    expect(version.stdout.trim()).toBe(`codex-cli ${expectedVersion}`)
    help = (await run(['--help'])).stdout
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(binary!, args, {
      timeout: TIMEOUT_MS,
      env: { ...process.env, CODEX_HOME: home }
    })
  }

  function listedSubcommands(): string[] {
    const section = help.split(/^Commands:\n/m)[1]?.split(/\n\s*\n/)[0] ?? ''
    return [...section.matchAll(/^ {2}([a-z][a-z0-9-]*)\s/gm)].map((match) => match[1])
  }

  it('lists --no-daemon in --help, which is what the wrapper probes', () => {
    expect(help).toContain('--no-daemon')
  })

  it('accepts --no-daemon first for every listed subcommand the wrapper does not skip', async () => {
    const subcommands = listedSubcommands()
    // Why a floor: a help layout change must fail here, not shrink the check to nothing.
    expect(subcommands.length).toBeGreaterThan(20)
    expect(subcommands).toEqual(expect.arrayContaining(['exec', 'resume', 'agents', 'queue']))
    const rejected: string[] = []
    for (const subcommand of subcommands.filter((name) => !WRAPPER_SKIPPED_SUBCOMMANDS.has(name))) {
      // Why bare `help`: clap's help subcommand treats `--help` as a command name.
      const args = subcommand === 'help' ? ['help'] : [subcommand, '--help']
      await run(['--no-daemon', ...args]).catch((error: { stderr?: string }) =>
        rejected.push(`${subcommand}: ${error.stderr?.trim() ?? String(error)}`)
      )
    }
    expect(rejected).toEqual([])
  })
})
