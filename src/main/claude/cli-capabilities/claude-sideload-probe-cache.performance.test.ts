import { expect, it } from 'vitest'
import { createClaudeCliFlagSupport } from './claude-cli-flag-support'

function support() {
  return createClaudeCliFlagSupport({
    probe: async () => '2.1.325',
    keyOf: async (command, cwd) => `${command}:${cwd}`,
    budgetMs: 1000,
    now: () => performance.now()
  })
}

it.each([10, 100])(
  'shares one background policy check across %i worktrees, including inconclusive results',
  async (count) => {
    const flags = support()
    let runs = 0
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        flags.probeSideload?.(
          {
            command: '/bin/claude',
            cwd: `/project/${index}`,
            env: { CLAUDE_CONFIG_DIR: '/account' }
          },
          async () => {
            runs++
            return { code: 1, stdout: '', stderr: 'unrelated failure' }
          }
        )
      )
    )
    expect(runs).toBe(1)
  }
)

it('bounds a burst of background account checks and admits a skipped account after the burst', async () => {
  const flags = support()
  const gate = Promise.withResolvers<void>()
  let running = 0
  let peak = 0
  let runs = 0
  const run = async () => {
    runs++
    running++
    peak = Math.max(peak, running)
    await gate.promise
    running--
    return { code: 1, stdout: '', stderr: 'unrelated failure' }
  }
  const pending = Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      flags.probeSideload?.(
        {
          command: '/bin/claude',
          cwd: '/project',
          env: { CLAUDE_CONFIG_DIR: `/account/${index}` }
        },
        run
      )
    )
  )
  gate.resolve()
  await pending
  expect(peak).toBe(2)
  expect(runs).toBe(32)
  await flags.probeSideload?.(
    { command: '/bin/claude', cwd: '/project', env: { CLAUDE_CONFIG_DIR: '/account/199' } },
    run
  )
  expect(runs).toBe(33)
})

// A distinct account needs one fact for the process lifetime, regardless of other account activity.
it.each([100, 1000])(
  'does not repeat checks while cycling through 33 folders %i times',
  async (count) => {
    const flags = support()
    let runs = 0
    for (let index = 0; index < count; index++) {
      await flags.probeSideload?.(
        {
          command: '/bin/claude',
          cwd: '/project',
          env: { CLAUDE_CONFIG_DIR: `/account/${index % 33}` }
        },
        async () => {
          runs++
          return { code: 1, stdout: '', stderr: 'unrelated failure' }
        }
      )
    }
    expect(runs).toBe(33)
  }
)

it.each([10, 100])(
  'skips %i queued callers after an authoritative refusal and drains live work',
  async (count) => {
    const flags = support()
    const gate = Promise.withResolvers<void>()
    const pending = ['/active/a', '/active/b'].map((account) =>
      flags.probeSideload?.(
        { command: '/bin/claude', cwd: '/project', env: { CLAUDE_CONFIG_DIR: account } },
        async () => {
          await gate.promise
          return { code: 1, stdout: '', stderr: 'unrelated failure' }
        }
      )
    )
    const launch = {
      command: '/bin/claude',
      cwd: '/project',
      env: { CLAUDE_CONFIG_DIR: '/queued' }
    }
    let staleRuns = 0
    let liveRuns = 0
    for (let index = 0; index < count; index++) {
      pending.push(
        flags.probeSideload?.(launch, async () => {
          staleRuns++
          return { code: 1, stdout: '', stderr: '' }
        })
      )
    }
    flags.observeExit(
      launch,
      new Error(
        "--plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)."
      )
    )
    pending.push(
      flags.probeSideload?.({ ...launch, env: { CLAUDE_CONFIG_DIR: '/live' } }, async () => {
        liveRuns++
        return { code: 1, stdout: '', stderr: 'unrelated failure' }
      })
    )
    gate.resolve()
    await Promise.all(pending)
    expect(staleRuns).toBe(0)
    expect(liveRuns).toBe(1)
  }
)
