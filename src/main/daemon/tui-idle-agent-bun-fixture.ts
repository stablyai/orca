import { fileURLToPath } from 'node:url'
import { spawnBunPty } from './pty-subprocess/bun-pty-process'
import type { BunPtyProcess } from './pty-subprocess/bun-pty-process-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { makeTuiIdleRuntime } from '../runtime/tui-idle-wait-test-harness'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import { TERMINAL_LIFECYCLE_METHODS } from '../runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { getForegroundProcessName } from '../../relay/pty-shell-utils'

const FIXTURE = fileURLToPath(new URL('../runtime/tui-idle-agent-fixture.mjs', import.meta.url))
const WORKTREE_ID = 'repo-1::/tmp/tui-idle-real-pty'
const TAB_ID = '55555555-5555-4555-8555-555555555555'
const LEAF_ID = '66666666-6666-4666-8666-666666666666'
const PTY_ID = 'pty-tui-idle-real'

const waitMethod = TERMINAL_LIFECYCLE_METHODS.find((method) => method.name === 'terminal.wait')!

const running: BunPtyProcess[] = []

async function cleanup() {
  while (running.length > 0) {
    try {
      const child = running.pop()
      if (child) {
        const exited = new Promise<void>((resolve) => child.onExit(() => resolve()))
        child.kill()
        await exited
        child.destroy()
      }
    } catch {
      // The fixture may already be gone.
    }
  }
}

async function startRealAgentPane(mode: 'explicit-idle' | 'quiet', workMs: number) {
  const child = spawnBunPty({
    file: process.execPath,
    args: [FIXTURE, mode, String(workMs)],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    cols: 120,
    rows: 30,
    cwd: '/tmp'
  })
  running.push(child)

  // Real foreground read against the real pty: the same helper the relay serves
  // `pty.getForegroundProcess` with, so corroboration is host-produced here too.
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/tui-idle-real-pty',
    getForegroundProcess: () => getForegroundProcessName(child.pid, child.process || null)
  })
  runtime.attachWindow(1)
  const graph: RuntimeSyncWindowGraph = {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Agent',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  }
  runtime.syncWindowGraph(1, graph)

  const transcript: string[] = []
  child.onData((data) => {
    transcript.push(data)
    runtime.onPtyData(PTY_ID, data, Date.now())
  })

  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  return { runtime, transcript, handle: terminals[0].handle }
}

/** Exactly what `orca terminal wait --terminal <h> --for tui-idle` reaches over RPC. */
async function terminalWait(
  runtime: OrcaRuntimeService,
  terminal: string,
  timeoutMs: number
): Promise<{ satisfied: boolean; elapsedMs: number }> {
  const startedAt = Date.now()
  try {
    const result = await waitMethod.handler(
      { terminal, for: 'tui-idle', timeoutMs },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.wait reads only `runtime` off its context; the rest is request plumbing this fixture has no use for.
      { runtime } as Parameters<typeof waitMethod.handler>[1]
    )
    return { satisfied: result.wait.satisfied === true, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    // Why only `timeout`: an unsatisfied wait is the outcome under test, but any other
    // failure means the harness broke and must not read as a passing refusal.
    if ((error instanceof Error ? error.message : String(error)) !== 'timeout') {
      throw error
    }
    return { satisfied: false, elapsedMs: Date.now() - startedAt }
  }
}

export async function runTuiIdleAgentWait(options: {
  mode: 'explicit-idle' | 'quiet'
  workMs: number
  timeoutMs: number
  waitForTitle: boolean
}): Promise<{ satisfied: boolean; elapsedMs: number; transcript: string }> {
  try {
    const { runtime, transcript, handle } = await startRealAgentPane(options.mode, options.workMs)
    if (options.waitForTitle) {
      const deadline = Date.now() + 5_000
      while (!transcript.join('').includes('\x1b]0;Codex\x07')) {
        if (Date.now() >= deadline) {
          throw new Error('Agent did not emit its name-only title')
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return {
      ...(await terminalWait(runtime, handle, options.timeoutMs)),
      transcript: transcript.join('')
    }
  } finally {
    await cleanup()
  }
}
