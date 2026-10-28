import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from '../bundled-skill-guides'
import { AGENT_LAUNCH_COMMAND_SPECS } from './agent-launch'
import { CORE_COMMAND_SPECS } from './core'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from './orchestration-worker-specs'

describe('project default agent guidance', () => {
  it('uses the target default for unspecified handoffs and preserves explicit choices', () => {
    const cli = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orca-cli')?.markdown
    const orchestrationGuide = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orchestration')
    const orchestration = [
      orchestrationGuide?.markdown ?? '',
      ...(orchestrationGuide?.references.map((reference) => reference.markdown) ?? [])
    ].join('\n')

    expect(cli).toContain('--no-parent --agent default --prompt')
    expect(cli).toContain('ORCA agent launch --agent default --worktree')
    expect(cli).toContain('ORCA worktree create --name task --agent claude --setup run')
    expect(orchestration).toContain('--worktree current --agent default --json')
    expect(orchestration).toContain('--agent claude --model opus --effort high')
    expect(orchestration).toContain('the target project')
  })

  it('documents default resolution and omission on command help', () => {
    const create = CORE_COMMAND_SPECS.find((spec) => spec.path.join(' ') === 'worktree create')
    const launch = AGENT_LAUNCH_COMMAND_SPECS[0]
    const worker = ORCHESTRATION_WORKER_COMMAND_SPECS[0]

    expect(create?.notes?.join(' ')).toContain('--agent default')
    expect(create?.notes?.join(' ')).toContain('Omitting --agent')
    expect(launch.notes?.join(' ')).toContain('--agent default')
    expect(worker.notes?.join(' ')).toContain('--agent default')
  })
})
