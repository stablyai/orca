import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import { resolveCodexCommand } from '../codex-cli/command'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'
import { proveCodexTuiRollout } from './codex-tui-rollout-proof'

const codexCommand = resolveCodexCommand()
const codexAvailable = spawnSync(codexCommand, ['--version']).status === 0
const itWithCodex = codexAvailable ? it : it.skip
const tempHomes: string[] = []

async function waitForTuiStart(proc: pty.IPty): Promise<string> {
  let output = ''
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Codex TUI did not initialize: ${output.slice(-500)}`)),
      15_000
    )
    proc.onData((data) => {
      output += data
      if (/OpenAI Codex|Welcome to Codex|Sign in with ChatGPT/i.test(output)) {
        clearTimeout(timeout)
        resolve(output)
      }
    })
    proc.onExit(({ exitCode }) => {
      clearTimeout(timeout)
      reject(
        new Error(`Codex TUI exited before initialization (${exitCode}): ${output.slice(-500)}`)
      )
    })
  })
}

async function waitForRollout(path: string, threadId: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const rollout = await readFile(path, 'utf8')
      if (rollout.includes(threadId)) {
        return rollout
      }
    } catch {
      // The rollout is created asynchronously after thread/start.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Codex did not materialize the resumed rollout')
}

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('real Codex structured-to-TUI resume', () => {
  itWithCodex(
    'resumes the exact isolated rollout and reaches the initial TUI screen',
    async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'orca-codex-tui-resume-'))
      tempHomes.push(codexHome)
      await writeFile(
        join(codexHome, 'config.toml'),
        [
          'model_provider = "orca-integration"',
          'model = "gpt-5"',
          '',
          '[model_providers.orca-integration]',
          'name = "Orca integration"',
          'base_url = "http://127.0.0.1:9/v1"',
          'wire_api = "responses"',
          'requires_openai_auth = false',
          '',
          `[projects.${JSON.stringify(process.cwd())}]`,
          'trust_level = "trusted"',
          ''
        ].join('\n')
      )
      const connection = await openCodexAppServerConnection({
        command: codexCommand,
        args: ['app-server'],
        env: { CODEX_HOME: codexHome }
      })
      const opened = await openCodexThread(
        connection,
        { cwd: process.cwd(), resumeThreadId: null },
        15_000
      )
      await connection.request(
        'turn/start',
        {
          threadId: opened.threadId,
          clientUserMessageId: 'real-binary-resume-fixture',
          input: [{ type: 'text', text: 'materialize the isolated resume fixture' }]
        },
        { timeoutMs: 15_000 }
      )
      expect(await waitForRollout(opened.historyPath!, opened.threadId)).toContain(opened.threadId)
      await connection.close()

      expect(opened.historyPath).toContain(opened.threadId)
      expect(opened.historyPath).toContain(join(codexHome, 'sessions'))
      const tui = pty.spawn(codexCommand, ['resume', '--no-alt-screen', opened.threadId], {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          ORCA_AGENT_LAUNCH_TOKEN: 'real-binary-resume-proof',
          TERM: 'xterm-256color'
        }
      })
      const tuiExit = new Promise<number>((resolve) =>
        tui.onExit(({ exitCode }) => resolve(exitCode))
      )
      const kittyKeyboard = new TerminalKittyKeyboardModeTracker()
      let tuiOutput = ''
      let lastOutputAt: number | null = null
      tui.onData((data) => {
        tuiOutput += data
        lastOutputAt = Date.now()
        kittyKeyboard.scan(data)
      })
      try {
        await expect(waitForTuiStart(tui)).resolves.toMatch(/Codex/i)
        const proof = await proveCodexTuiRollout({
          codexHome,
          threadId: opened.threadId,
          kittyKeyboardFlags: kittyKeyboard.flags,
          readOutput: () => ({ text: tuiOutput, lastOutputAt }),
          write: (data) => {
            tui.write(data)
            return true
          }
        })
        expect(await realpath(proof.transcriptPath)).toBe(await realpath(opened.historyPath!))
      } finally {
        try {
          tui.kill()
        } catch {
          // Already exited.
        }
        await Promise.race([
          tuiExit,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error('Codex TUI did not exit after cleanup')), 5_000)
          )
        ])
      }
    },
    30_000
  )
})
