import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPreparedAgentLaunchStatus } from '../../shared/prepared-agent-launch'
import { createObservedSetupCommand } from '../../shared/observed-setup-launch'
import { fingerprintPreparedAgentLaunch } from './prepared-agent-launch-payload'
import { HeadlessEmulator } from './headless-emulator'
import { createPtySubprocess } from './pty-subprocess'
import { TerminalHost } from './terminal-host'

const COLS = 100
const ROWS = 30
const FAILED = 'Setup failed, so Codex was not started. Fix Setup, then start Codex from a new tab.'
const BASH = '/bin/bash'

let host: TerminalHost | undefined
let home: string | undefined
afterEach(async () => {
  await host?.dispose()
  host = undefined
  if (home) {
    rmSync(home, { recursive: true, force: true })
  }
})

/** What the Setup tab shows on reattach, as saved bytes and as rendered text. */
async function setupScreen(terminalHost: TerminalHost): Promise<string> {
  const attached = await terminalHost.createOrAttach({
    sessionId: 'setup',
    cols: COLS,
    rows: ROWS,
    streamClient: { onData: vi.fn(), onExit: vi.fn() }
  })
  const snapshot = attached.snapshot!.snapshotAnsi
  const screen = new HeadlessEmulator({ cols: COLS, rows: ROWS })
  screen.writeSync(snapshot)
  const text = screen.getVisibleLines().join('\n')
  screen.dispose()
  // The saved snapshot and what it renders: neither may carry plumbing.
  return `${snapshot}\n${text}`
}

describe.skipIf(process.platform === 'win32' || spawnSync(BASH, ['--version']).status !== 0)(
  'a prepared Setup in a real shell',
  () => {
    it.each([0, 3])(
      'completes from its status file with exit %i and shows only the user’s output',
      async (code) => {
        home = mkdtempSync(join(tmpdir(), 'orca-prepared-setup-'))
        const runner = join(home, 'setup-runner.sh')
        writeFileSync(runner, `echo USER_SETUP_OUTPUT\nexit ${code}\n`)
        const attemptId = randomUUID()
        const launcher = createObservedSetupCommand({
          runnerScriptPath: runner,
          platform: 'posix',
          attemptId
        })
        const env = {
          HOME: home,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          SHELL: BASH,
          TERM: 'xterm-256color',
          PS1: 'setup$ '
        }
        const typed: string[] = []
        host = new TerminalHost({
          spawnSubprocess: async (opts) => {
            const subprocess = await createPtySubprocess(opts)
            const write = subprocess.write.bind(subprocess)
            subprocess.write = (data) => {
              typed.push(data)
              return write(data)
            }
            return subprocess
          }
        })
        const payload = {
          launch: {
            sessionId: 'agent',
            cols: COLS,
            rows: ROWS,
            cwd: home,
            env,
            shellOverride: BASH,
            command: 'echo AGENT_RAN'
          },
          setup: {
            spawn: {
              sessionId: 'setup',
              cols: COLS,
              rows: ROWS,
              cwd: home,
              env: { ...env, ...launcher.env },
              shellOverride: BASH,
              command: launcher.command
            },
            attemptId,
            deadline: Date.now() + 7_200_000
          }
        }
        const prepared = await host.preparedAgentLaunch({
          action: 'prepare',
          operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
          fingerprint: fingerprintPreparedAgentLaunch(payload),
          claim: {
            kind: 'fresh-launch',
            agent: 'codex',
            keyId: 'key',
            identityDigest: 'a'.repeat(43),
            worktreeScopeDigest: 'b'.repeat(43),
            digestVersion: 1
          },
          surface: {
            worktreeId: 'wt',
            tabId: 'tab_agent',
            leafId: randomUUID(),
            terminalHandle: 'term_agent'
          }
        })
        if (!isPreparedAgentLaunchStatus(prepared)) {
          throw new Error('missing preparation')
        }
        await host.preparedAgentLaunch({ action: 'accept', identity: prepared, ...payload })
        const status = () => host!.preparedAgentLaunch({ action: 'status', identity: prepared })

        await vi.waitFor(
          async () =>
            expect(await status()).toMatchObject(
              code === 0
                ? { execution: 'started', physical: { sessionId: 'agent' } }
                : { execution: 'settled', failure: 'setup-failed', setup: { exitCode: 3 } }
            ),
          { timeout: 15_000, interval: 50 }
        )
        if (code !== 0) {
          await expect(
            host.preparedAgentLaunch({
              action: 'writeSetupOutcome',
              identity: prepared,
              text: FAILED
            })
          ).resolves.toEqual({ written: true })
        }

        const shown = await setupScreen(host)
        expect(shown).toContain('USER_SETUP_OUTPUT')
        expect(shown.includes(`[orca] ${FAILED}`)).toBe(code !== 0)
        // No plumbing: not the attempt, the status file, the runner path or the wrapper's text.
        for (const plumbing of [
          attemptId,
          '__ORCA_SETUP_COMPLETE__',
          'setup-status',
          runner,
          'status_file',
          'printf'
        ]) {
          expect(shown).not.toContain(plumbing)
          expect(typed.join('')).not.toContain(plumbing)
        }
      },
      30_000
    )
  }
)
