import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { proveClaudeChildExit } from './claude-agent-sdk-exit-proof'
import { managedChild } from './claude-child-exit-proof-fixture'

const COOPERATIVE_CHILD = `
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
process.stdout.write('ready\\n')
`

/** Sample at the close boundary; zombies count as exited even though kill(pid, 0) finds them. */

// ps start times have second precision; cross that boundary so the snapshot permits forced signals.

// Model registry retries: slow process-table reads may leave one close attempt unproven.

function spawnScript(script: string): ChildProcessWithoutNullStreams {
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', script],
    stdio: ['pipe', 'pipe', 'pipe']
  })
  managedChild(child)
  return child
}

function firstStdoutLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve) => {
    child.stdout.setEncoding('utf8').once('data', (chunk: string) => resolve(chunk.trim()))
  })
}

describe('claude child exit proof', () => {
  it('proves a clean close of a childless root with one snapshot and no signal', async () => {
    const child = spawnScript(COOPERATIVE_CHILD)
    expect(await firstStdoutLine(child)).toBe('ready')

    await expect(proveClaudeChildExit({ managed: managedChild(child) })).resolves.toBe(true)
  }, 20_000)
})
