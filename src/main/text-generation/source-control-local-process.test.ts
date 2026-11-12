import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cancelGenerateCommitMessageLocal } from './commit-message-text-generation'
import { spawnSourceControlAgent } from './source-control-agent-launch'

import { generateCommitMessage } from './source-control-text-generation-requests'

const { terminateTreeMock } = vi.hoisted(() => ({
  terminateTreeMock: vi.fn(async () => true)
}))

vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: terminateTreeMock
}))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  vi.useRealTimers()
  terminateTreeMock.mockClear()
})

describe.runIf(process.platform !== 'win32')(
  'killSourceControlAgentProcess on a real agent',
  () => {
    it('holds the Codex home until a canceled agent has stopped through its supervisor', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-supervised-cancel-'))
      const pids: number[] = []
      try {
        const home = join(folder, 'codex-home')
        for (const repo of ['first', 'second']) {
          mkdirSync(join(folder, repo))
        }
        const pidFile = join(folder, 'first-pid')
        const stoppedFile = join(folder, 'first-stopped')
        // Model a CLI that ignores stdin EOF and flushes state before stopping on SIGTERM.
        const slowStop = join(folder, 'slow-stop.cjs')
        writeFileSync(
          slowStop,
          `if (process.argv.includes('mcp')) { console.log('[]'); process.exit(0) }
process.stdin.resume()
process.on('SIGTERM', () => setTimeout(() => {
  require('node:fs').writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
  process.exit(0)
}, 300))
setInterval(() => {}, 60000)
// Publish readiness only after the signal handler is installed.
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
`
        )
        const answers = join(folder, 'answers.cjs')
        writeFileSync(
          answers,
          "process.stdin.resume().on('end', () => console.log(process.argv.includes('mcp') ? '[]' : 'Update README'))\n"
        )
        const firstAliveAtSecondSpawn: boolean[] = []
        const spawnAgent = vi.fn((input: Parameters<typeof spawnSourceControlAgent>[0]) => {
          if (pids.length > 0 && !input.args.includes('mcp')) {
            firstAliveAtSecondSpawn.push(isAlive(pids[0]!))
          }
          return spawnSourceControlAgent(input)
        })
        const request = (cwd: string, script: string): ReturnType<typeof generateCommitMessage> =>
          generateCommitMessage({
            context: { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
            params: {
              agentId: 'codex',
              model: 'gpt-5.5',
              agentCommandOverride: `CODEX_HOME="${home}" "${process.execPath}" "${script}"`
            },
            target: { kind: 'local', cwd, env: process.env },
            spawnAgent
          })

        const first = request(join(folder, 'first'), slowStop)
        await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 })
        pids.push(Number(readFileSync(pidFile, 'utf8')))
        cancelGenerateCommitMessageLocal(join(folder, 'first'))
        await expect(first).resolves.toMatchObject({ canceled: true })

        await expect(request(join(folder, 'second'), answers)).resolves.toMatchObject({
          success: true,
          message: 'Update README'
        })
        expect(firstAliveAtSecondSpawn).toEqual([false])
        expect(readFileSync(stoppedFile, 'utf8')).toBe('stopped')
        expect(terminateTreeMock).not.toHaveBeenCalled()
      } finally {
        for (const pid of pids) {
          if (isAlive(pid)) {
            process.kill(pid, 'SIGKILL')
          }
        }
        rmSync(folder, { recursive: true, force: true })
      }
    })
  }
)
