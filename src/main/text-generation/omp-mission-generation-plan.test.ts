import { describe, expect, it } from 'vitest'
import { planOmpMissionGeneration } from './omp-mission-generation-plan'

describe('planOmpMissionGeneration', () => {
  const files = { configPath: '/private/config.yml', extensionPath: '/private/planner-guard.mjs' }

  it('requires the per-call overlay, trusted guard and Mission-only system prompt', () => {
    const result = planOmpMissionGeneration('Return JSON only.', undefined, 'escape', files)
    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: expect.arrayContaining([
          '--config',
          files.configPath,
          '--trusted-extension',
          files.extensionPath,
          '--system-prompt'
        ])
      }
    })
  })

  it.each([
    '--tools bash',
    '--tools=bash',
    '-e plugin.mjs',
    '--extension=plugin.mjs',
    '--hook plugin.mjs',
    '--trusted-extension /other.mjs',
    '--plugin-dir plugins',
    '--config unsafe.yml',
    '--mode rpc',
    '--session session.jsonl',
    '--resume abc',
    '--continue',
    '--plan-yolo',
    '--',
    'commit'
  ])('rejects a command override that could escape planning: %s', (args) => {
    expect(planOmpMissionGeneration('Plan.', `omp ${args}`, 'escape', files)).toMatchObject({
      ok: false,
      error: expect.stringContaining('OMP Mission')
    })
  })

  it.each([
    {
      backslash: 'literal' as const,
      override: '"C:\\Program Files\\OMP\\omp.exe" --profile work',
      binary: 'C:\\Program Files\\OMP\\omp.exe'
    },
    {
      backslash: 'escape' as const,
      override: '/opt/my\\ agents/omp --profile work',
      binary: '/opt/my agents/omp'
    }
  ])('preserves the $backslash executable path and selected profile', (testCase) => {
    const result = planOmpMissionGeneration(
      'Return JSON only.',
      testCase.override,
      testCase.backslash,
      files
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        binary: testCase.binary,
        stdinPayload: 'Return JSON only.',
        label: 'OMP'
      }
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args.slice(0, 2)).toEqual(['--profile', 'work'])
    expect(result.plan.args).not.toContain('--model')
  })
})
