import { describe, expect, it } from 'vitest'
import {
  PipelineTemplateRegistry,
  createBuiltInPipelineTemplateRegistry
} from './template-registry'

describe('PipelineTemplateRegistry', () => {
  it('lists the built-in Pipeline templates', () => {
    const registry = createBuiltInPipelineTemplateRegistry()

    expect(registry.listTemplates()).toEqual(
      expect.arrayContaining([
        {
          id: 'parallel-planner-with-review',
          name: 'Parallel Planner With Review',
          description: expect.any(String),
          version: 1,
          maxConcurrentDefault: 2,
          maxIterationsDefault: 10
        },
        {
          id: 'sequential-reviewer',
          name: 'Sequential Reviewer',
          description: expect.any(String),
          version: 1,
          maxConcurrentDefault: 1,
          maxIterationsDefault: 10
        }
      ])
    )

    const template = registry.getTemplate('parallel-planner-with-review')
    expect(template?.stages.map((stage) => stage.stage)).toEqual([
      'task_source',
      'planner',
      'implement',
      'review',
      'merge',
      'verify'
    ])
    expect(template?.prompts.planner.source.type).toBe('template')
    expect(template?.prompts.implementer.source.type).toBe('template')
    expect(template?.prompts.reviewer?.source.type).toBe('template')
    expect(template?.prompts.merger.source.type).toBe('template')
    expect(template?.prompts.verifier?.source.type).toBe('inline')
    expect(template?.plannerOutput).toMatchObject({ tag: 'plan', version: 1 })
    expect(template?.taskSourceKinds).toEqual(['github_issues'])

    const sequential = registry.getTemplate('sequential-reviewer')
    expect(sequential?.maxConcurrentDefault).toBe(1)
    expect(sequential?.taskSourceKinds).toEqual(['github_issues'])
  })

  it('rejects duplicate or incomplete templates', () => {
    const registry = createBuiltInPipelineTemplateRegistry()
    const template = registry.getTemplate('parallel-planner-with-review')!

    expect(() => new PipelineTemplateRegistry([template, template])).toThrow(/Duplicate/)
    expect(
      () =>
        new PipelineTemplateRegistry([
          {
            ...template,
            prompts: { ...template.prompts, planner: undefined! }
          }
        ])
    ).toThrow(/planner/)
  })

  it('keeps completion markers out of built-in prompt text', () => {
    const registry = createBuiltInPipelineTemplateRegistry()
    const template = registry.getTemplate('parallel-planner-with-review')!
    const promptTexts = Object.values(template.prompts).flatMap((prompt) =>
      prompt?.source.type === 'template' || prompt?.source.type === 'inline'
        ? [prompt.source.text]
        : []
    )

    expect(promptTexts.join('\n')).not.toContain('<plan>')
    expect(promptTexts.join('\n')).not.toContain('</plan>')
    expect(promptTexts.join('\n')).not.toContain('<promise>')
    expect(promptTexts.join('\n')).not.toContain('</promise>')
  })
})
