import { describe, expect, it } from 'vitest'
import { PipelineStructuredOutputError, extractPipelinePlannerOutput } from './structured-output'

const context = {
  runId: 'run_1',
  iterationId: 'iter_1',
  stageId: 'stage_1',
  terminalId: 'term_1'
}

describe('extractPipelinePlannerOutput', () => {
  it('uses the last plan tag and unwraps json code fences', () => {
    const output = extractPipelinePlannerOutput(
      `
      <plan>{"issues":[{"id":"old","title":"Old","branch":"old"}]}</plan>
      More agent text.
      <plan>
      \`\`\`json
      {"issues":[{"id":"4","title":"Add DB","branch":"pipeline/4","blockedBy":["3"]}]}
      \`\`\`
      </plan>
      `,
      context
    )

    expect(output).toEqual({
      issues: [{ id: '4', title: 'Add DB', branch: 'pipeline/4', blockedBy: ['3'] }]
    })
  })

  it('includes pipeline context and output summary on missing tags', () => {
    expect(() => extractPipelinePlannerOutput('planner forgot the tag', context)).toThrow(
      PipelineStructuredOutputError
    )

    try {
      extractPipelinePlannerOutput('planner forgot the tag', context)
    } catch (error) {
      expect(error).toMatchObject({
        failureKind: 'missing_tag',
        runId: 'run_1',
        iterationId: 'iter_1',
        stageId: 'stage_1',
        terminalId: 'term_1',
        tag: 'plan',
        rawOutputSummary: 'planner forgot the tag'
      })
    }
  })

  it('fails invalid json and schema mismatches with different failure kinds', () => {
    expect(() => extractPipelinePlannerOutput('<plan>{ nope }</plan>', context)).toThrow(
      /invalid JSON/
    )

    try {
      extractPipelinePlannerOutput(
        '<plan>{"issues":[{"id":"4","title":"Missing branch"}]}</plan>',
        context
      )
    } catch (error) {
      expect(error).toMatchObject({ failureKind: 'schema_validation' })
    }
  })
})
