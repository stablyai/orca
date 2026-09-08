import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { seedEmulatorAgentHistoryFixture } from './emulator-agent-history-fixture.mjs'

const execFileAsync = promisify(execFile)
export const HOSTED_CHAT_TERMINAL_TITLE = 'Hosted Chat Fixture'

export async function createHostedChatRuntimeFixture({
  orcaCli,
  runtimeDirectory,
  worktree,
  timeoutMs
}) {
  if (process.platform !== 'darwin') {
    throw new Error('Hosted chat runtime fixture currently targets the owned iOS harness')
  }
  const pairingDirectory = path.join(runtimeDirectory, 'paired-host')
  const transcriptPath = seedEmulatorAgentHistoryFixture({
    homeDir: path.join(pairingDirectory, 'home'),
    workspacePath: worktree
  })
  const receiptPath = path.join(runtimeDirectory, 'chat-pty-input.jsonl')
  const env = {
    ...process.env,
    ORCA_DEV_USER_DATA_PATH: path.join(pairingDirectory, 'userData'),
    ORCA_USER_DATA_PATH: path.join(pairingDirectory, 'userData')
  }
  const cli = async (args) => {
    const { stdout } = await execFileAsync(orcaCli, args, {
      cwd: worktree,
      env,
      timeout: timeoutMs,
      encoding: 'utf8'
    })
    return JSON.parse(stdout)
  }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const command = [
    process.execPath,
    path.join(worktree, 'mobile/scripts/hosted-chat-pty.cjs'),
    transcriptPath,
    receiptPath
  ]
    .map(quote)
    .join(' ')
  const created = await cli([
    'terminal',
    'create',
    '--worktree',
    `path:${worktree}`,
    '--title',
    HOSTED_CHAT_TERMINAL_TITLE,
    '--command',
    command,
    '--json'
  ])
  const handle = created.result?.terminal?.handle
  if (!handle) {
    throw new Error('Owned chat terminal creation returned no handle')
  }
  const cleanup = () => cli(['terminal', 'close', '--terminal', handle, '--json'])
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await cli(['terminal', 'list', '--worktree', `path:${worktree}`, '--json'])
      const terminal = state.result?.terminals?.find((entry) => entry.handle === handle)
      const ready = await readFile(receiptPath).then(
        () => true,
        () => false
      )
      if (ready && terminal?.agentIdentity === 'codex') {
        return {
          handle,
          transcriptPath,
          receiptPath,
          cleanup,
          readTerminals: async () =>
            (await cli(['terminal', 'list', '--worktree', `path:${worktree}`, '--json'])).result
              .terminals
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('Owned chat PTY did not finish authenticated hook binding')
  } catch (error) {
    await cleanup()
    throw error
  }
}
