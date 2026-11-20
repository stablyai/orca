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
