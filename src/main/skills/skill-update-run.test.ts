import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SkillUpdateRun } from '../../shared/skill-freshness'
import { CANCEL_RELEASE_TIMEOUT_MS, SkillUpdateRunner } from './skill-update-run'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid: number | undefined = 1234
  kill = vi.fn()
}

function makeRunner(
  overrides: {
    rescanOutdatedNames?: (names: string[]) => Promise<string[]>
    resolveCommand?: (name: string) => string
    killTree?: (pid: number, killRoot: () => void) => Promise<void>
    buildSpawnArgs?: (command: string, args: string[]) => { spawnCmd: string; spawnArgs: string[] }
  } = {}
) {
  const child = new FakeChild()
  const spawnCalls: { command: string; args: string[]; options: Record<string, unknown> }[] = []
  const states: SkillUpdateRun[] = []
  const runner = new SkillUpdateRunner({
    now: () => 1000,
    resolveCommand: overrides.resolveCommand ?? (() => '/usr/local/bin/npx'),
    rescanOutdatedNames: overrides.rescanOutdatedNames,
    // Default to a no-op sweep so tests never signal a real PID.
    killTree: overrides.killTree ?? (async (_pid, killRoot) => killRoot()),
    buildSpawnArgs: overrides.buildSpawnArgs,
    onState: (run) => states.push(run),
    spawnProcess: ((command: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options })
      return child as never
    }) as never
  })
  return { runner, child, spawnCalls, states }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('SkillUpdateRunner', () => {
  it('passes both non-interactive flags and the sorted skill names', () => {
    const { runner, spawnCalls } = makeRunner()

    expect(runner.start(['orchestration', 'orca-cli'])).toEqual({ started: true })
    expect(spawnCalls[0].command).toBe('/usr/local/bin/npx')
    // `npx --yes` skips the install prompt; `skills -y` takes the CLI's own
    // non-interactive branch. Dropping either can wedge the run.
    expect(spawnCalls[0].args).toEqual([
      '--yes',
      'skills',
      'update',
      'orca-cli',
      'orchestration',
      '--global',
      '-y'
    ])
  })

  it('ignores stdin so the CLI sees a non-TTY', () => {
    const { runner, spawnCalls } = makeRunner()
    runner.start(['orca-cli'])

    expect(spawnCalls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('rejects names that could carry shell syntax', () => {
    const { runner, spawnCalls } = makeRunner()

    expect(runner.start(['orca-cli; rm -rf /'])).toEqual({
      started: false,
      reason: 'invalid-names'
    })
    expect(spawnCalls).toHaveLength(0)
  })

  it('refuses a second concurrent run', () => {
    const { runner } = makeRunner()
    runner.start(['orca-cli'])

    expect(runner.start(['orchestration'])).toEqual({ started: false, reason: 'already-running' })
  })

  it('strips ANSI colour and carriage returns from captured output', async () => {
    const { runner, child } = makeRunner({ rescanOutdatedNames: async () => [] })
    runner.start(['orca-cli'])
    child.stdout.emit('data', Buffer.from('\x1b[36mChecking\x1b[0m\rUpdating orca-cli…'))
    child.emit('close', 0)
    await flush()

    const run = runner.getState()
    expect(run.state).toBe('success')
    expect(run.state === 'success' && run.output).toBe('Checking\nUpdating orca-cli…')
  })

  it('treats a clean re-scan as success even though the exit code is non-zero', async () => {
    // A peer skill outside our request can fail the process; what we asked for landed.
    const { runner, child } = makeRunner({ rescanOutdatedNames: async () => [] })
    runner.start(['orca-cli'])
    child.emit('close', 1)
    await flush()

    expect(runner.getState().state).toBe('success')
  })

  it('attributes failure to the names the re-scan says are still outdated', async () => {
    const { runner, child } = makeRunner({
      rescanOutdatedNames: async () => ['orchestration']
    })
    runner.start(['orca-cli', 'orchestration'])
    child.emit('close', 1)
    await flush()

    const run = runner.getState()
    expect(run.state).toBe('error')
    expect(run.state === 'error' && run.failedNames).toEqual(['orchestration'])
  })

  it('fails every requested name when the re-scan itself throws', async () => {
    const { runner, child } = makeRunner({
      rescanOutdatedNames: async () => {
        throw new Error('scan blew up')
      }
    })
    runner.start(['orca-cli'])
    child.emit('error', new Error('spawn ENOENT'))
    await flush()

    const run = runner.getState()
    expect(run.state).toBe('error')
    expect(run.state === 'error' && run.failedNames).toEqual(['orca-cli'])
    expect(run.state === 'error' && run.message).toBe('spawn ENOENT')
  })

  it('keeps the spawn error when the failed child also emits close', async () => {
    // A spawn failure emits `error` *then* `close`. Without a latch the second
    // settle overwrites `spawn ENOENT` with a useless "exited with code null".
    const rescan = vi.fn(async () => ['orca-cli'])
    const { runner, child } = makeRunner({ rescanOutdatedNames: rescan })
    runner.start(['orca-cli'])
    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', null)
    await flush()

    const run = runner.getState()
    expect(run.state === 'error' && run.message).toBe('spawn ENOENT')
    expect(rescan).toHaveBeenCalledTimes(1)
  })

  it('refuses a new run until the cancelled process tree is actually dead', async () => {
    // The sweep waits for a descendant snapshot before it signals anything, so
    // releasing the UI synchronously would let a second npx write the same
    // bundles as the one still being killed.
    let finishKill = (): void => {}
    const { runner } = makeRunner({
      killTree: (_pid, killRoot) =>
        new Promise<void>((resolve) => {
          finishKill = () => {
            killRoot()
            resolve()
          }
        })
    })
    runner.start(['orca-cli'])
    runner.cancel()
    await flush()

    expect(runner.getState().state).toBe('running')
    expect(runner.start(['orchestration'])).toEqual({ started: false, reason: 'already-running' })

    finishKill()
    await flush()
    expect(runner.getState()).toEqual({ state: 'idle' })
    expect(runner.start(['orchestration'])).toEqual({ started: true })
  })

  it('releases the run even if the kill sweep never settles', async () => {
    vi.useFakeTimers()
    try {
      // Stop is already spent by this point, so a sweep that hangs would leave
      // the run wedged in `running` with no way out.
      const { runner } = makeRunner({ killTree: () => new Promise<void>(() => {}) })
      runner.start(['orca-cli'])
      runner.cancel()
      const stopping = runner.getState()
      expect(stopping.state).toBe('running')
      // Surfaced so the dialog can retire the Stop affordance it already spent.
      expect(stopping.state === 'running' && stopping.stopping).toBe(true)

      await vi.advanceTimersByTimeAsync(CANCEL_RELEASE_TIMEOUT_MS)

      expect(runner.getState()).toEqual({ state: 'idle' })
      expect(runner.start(['orchestration'])).toEqual({ started: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a cancelled child settle the run that replaced it', async () => {
    const children: FakeChild[] = []
    const states: SkillUpdateRun[] = []
    const runner = new SkillUpdateRunner({
      now: () => 1000,
      resolveCommand: () => '/usr/local/bin/npx',
      rescanOutdatedNames: async () => [],
      // Never let a test reach the real sweep — it would signal live PIDs.
      killTree: async (_pid, killRoot) => killRoot(),
      onState: (run) => states.push(run),
      spawnProcess: (() => {
        const child = new FakeChild()
        children.push(child)
        return child as never
      }) as never
    })
    runner.start(['orca-cli'])
    runner.cancel()
    await flush()
    runner.start(['orchestration'])
    // The killed child's exit lands after the replacement is already in flight.
    children[0].stdout.emit('data', Buffer.from('output from the dead run'))
    children[0].emit('close', 1)
    await flush()

    const run = runner.getState()
    expect(run.state).toBe('running')
    expect(run.state === 'running' && run.names).toEqual(['orchestration'])
    expect(run.state === 'running' && run.output).toBe('')
    expect(states.some((state) => state.state === 'error')).toBe(false)
  })

  it('returns to idle on cancel and stops reporting output', async () => {
    const { runner, child, states } = makeRunner({ rescanOutdatedNames: async () => [] })
    runner.start(['orca-cli'])
    runner.cancel()
    child.stdout.emit('data', Buffer.from('late output'))
    await flush()

    expect(child.kill).toHaveBeenCalled()
    expect(runner.getState()).toEqual({ state: 'idle' })
    expect(states.at(-1)).toEqual({ state: 'idle' })
  })

  it('ignores a re-scan that resolves after the run was cancelled', async () => {
    let releaseRescan = (): void => {}
    const { runner, child } = makeRunner({
      rescanOutdatedNames: () =>
        new Promise<string[]>((resolve) => {
          releaseRescan = () => resolve([])
        })
    })
    runner.start(['orca-cli'])
    child.emit('close', 0)
    await flush()
    // The re-scan re-hashes every package, so a cancel lands well inside it.
    runner.cancel()
    releaseRescan()
    await flush()

    expect(runner.getState()).toEqual({ state: 'idle' })
  })

  it('kills the whole npx tree on cancel, not just the wrapper', async () => {
    const killTree = vi.fn(async (_pid: number, killRoot: () => void) => {
      killRoot()
    })
    const { runner, child } = makeRunner({ killTree })
    child.pid = 4242
    runner.start(['orca-cli'])
    runner.cancel()
    await flush()

    expect(killTree).toHaveBeenCalledWith(4242, expect.any(Function))
    expect(child.kill).toHaveBeenCalled()
  })

  it('surfaces an unspawnable command path instead of silently doing nothing', async () => {
    // A Windows profile directory containing `&` makes the cmd.exe rail reject
    // the resolved npx path; the names are already canonical by this point.
    const { runner, states } = makeRunner({
      resolveCommand: () => 'C:\\Users\\A&B\\AppData\\Roaming\\npm\\npx.cmd',
      buildSpawnArgs: () => {
        throw new Error('unsafe batch arguments')
      }
    })

    const result = runner.start(['orca-cli'])

    expect(result.started).toBe(false)
    const run = runner.getState()
    expect(run.state).toBe('error')
    expect(run.state === 'error' && run.failedNames).toEqual(['orca-cli'])
    expect(states.at(-1)?.state).toBe('error')
  })

  it('coalesces progress frames into one push instead of one per chunk', async () => {
    const { runner, child, states } = makeRunner({ rescanOutdatedNames: async () => [] })
    runner.start(['orca-cli'])
    const pushesAfterStart = states.length
    for (let frame = 0; frame < 25; frame += 1) {
      child.stdout.emit('data', Buffer.from(`\rfetching ${frame}%`))
    }
    expect(states.length).toBe(pushesAfterStart)

    child.emit('close', 0)
    await flush()

    const run = runner.getState()
    expect(run.state).toBe('success')
    // Nothing is dropped — the tail is drained before the run settles.
    expect(run.state === 'success' && run.output).toContain('fetching 24%')
  })

  it('acknowledge clears a settled run but leaves a live one alone', async () => {
    const { runner, child } = makeRunner({ rescanOutdatedNames: async () => [] })
    runner.start(['orca-cli'])
    runner.acknowledge()
    expect(runner.getState().state).toBe('running')

    child.emit('close', 0)
    await flush()
    runner.acknowledge()
    expect(runner.getState()).toEqual({ state: 'idle' })
  })
})
