import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { proveClaudeChildExit } from './claude-agent-sdk-exit-proof'
import { managedChild } from './claude-child-exit-proof-fixture'

function childWithDescendantScript(input: {
  rootTrapsSigterm: boolean
  descendantTrapsSigterm: boolean
}): string {
  const descendantScript = `${input.descendantTrapsSigterm ? 'process.on("SIGTERM", () => {}); ' : ''}setInterval(() => {}, 1000000)`
  const rootBehaviour = input.rootTrapsSigterm
    ? `process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
setInterval(() => {}, 1000000)`
    : `process.stdin.on('end', () => process.exit(0))
process.stdin.resume()`
  return `
const descendant = require('node:child_process').spawn(
  process.execPath,
  ['-e', ${JSON.stringify(descendantScript)}],
  { stdio: 'ignore' }
)
descendant.unref()
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\\n')
${rootBehaviour}
`
}

const COOPERATIVE_CHILD = `
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
process.stdout.write('ready\\n')
`

/** Sample at the close boundary; zombies count as exited even though kill(pid, 0) finds them. */
function descendantState(pid: number): 'running' | 'exited' {
  let state: string
  try {
    state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
    }).trim()
  } catch (error) {
    // ps exits 1 when no process matches; anything else is a failed probe, not an answer.
    if ((error as { status?: number }).status !== 1) {
      throw error
    }
    return 'exited'
  }
  return state.startsWith('Z') ? 'exited' : 'running'
}

// ps start times have second precision; cross that boundary so the snapshot permits forced signals.
function ageDescendantPastTheCaptureSecond(): Promise<void> {
  // ast-grep-ignore: test-no-wall-clock -- ps reports native process birth times on this clock.
  return new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 20))
}

// Model registry retries: slow process-table reads may leave one close attempt unproven.
async function proveExitWithRetries(
  input: Parameters<typeof proveClaudeChildExit>[0],
  attempts = 3
): Promise<boolean> {
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (await proveClaudeChildExit(input)) {
      return true
    }
  }
  return proveClaudeChildExit(input)
}

function spawnScript(script: string): PipedChildProcess {
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', script],
    stdio: ['pipe', 'pipe', 'pipe']
  })
  managedChild(child)
  return child
}

function firstStdoutLine(child: PipedChildProcess): Promise<string> {
  return new Promise((resolve) => {
    child.stdout.setEncoding('utf8').once('data', (chunk: string) => resolve(chunk.trim()))
  })
}

describe('claude child exit proof', () => {
  it.runIf(process.platform !== 'win32')(
    'reports a proven exit only once a SIGTERM-resistant descendant is gone at the close boundary',
    async () => {
      const child = spawnScript(
        childWithDescendantScript({ rootTrapsSigterm: true, descendantTrapsSigterm: true })
      )
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      expect(descendantState(descendantPid)).toBe('running')
      await ageDescendantPastTheCaptureSecond()

      try {
        const proven = await proveExitWithRetries({ managed: managedChild(child) })
        // Assert at lease release; polling afterward could conceal a surviving descendant.
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it.runIf(process.platform !== 'win32')(
    'proves a promptly exiting root only once its stubborn descendant is gone too',
    async () => {
      const child = spawnScript(
        childWithDescendantScript({ rootTrapsSigterm: false, descendantTrapsSigterm: true })
      )
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      expect(descendantState(descendantPid)).toBe('running')
      await ageDescendantPastTheCaptureSecond()

      try {
        const proven = await proveExitWithRetries({ managed: managedChild(child) })
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it.runIf(process.platform !== 'win32')(
    'still proves a stubborn child whose descendant honours SIGTERM',
    async () => {
      const child = spawnScript(
        childWithDescendantScript({ rootTrapsSigterm: true, descendantTrapsSigterm: false })
      )
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      try {
        const proven = await proveExitWithRetries({ managed: managedChild(child) })
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it('proves a clean close of a childless root with one snapshot and no signal', async () => {
    const child = spawnScript(COOPERATIVE_CHILD)
    expect(await firstStdoutLine(child)).toBe('ready')

    await expect(proveClaudeChildExit({ managed: managedChild(child) })).resolves.toBe(true)
  }, 20_000)
})
