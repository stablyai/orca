import { describe, expect, it } from 'vitest'
import { NewSessionResponseSchema } from '../generated/acp-protocol.generated'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

// Shape captured from the server's ask_question when the client advertises form elicitation.
const question = { type: 'string', title: 'Pick a color', oneOf: [{ const: '1', title: 'Red' }] }
const writeIn = { type: 'string', title: 'Other', description: 'Optional free-form answer' }
const form = (message: string, properties: Record<string, unknown>) => ({
  sessionId: 's1',
  toolCallId: 'call_1',
  mode: 'form',
  message,
  requestedSchema: { type: 'object', properties }
})
const present = (params: unknown) => ANTIGRAVITY_ACP_DIALECT.request?.('elicitation/create', params)

describe('Antigravity ask_question forms', () => {
  it('shows the question with a write-in field and returns typed text as the answer', () => {
    const presentation = present(
      form('The agent has a question.', { q1: question, q1_other: writeIn })
    )
    expect(presentation?.body).toMatchObject({
      kind: 'question',
      question: 'Pick a color',
      options: [{ id: 'o1', label: 'Red' }],
      freeTextQuestionId: 'q1'
    })
    expect(
      presentation?.reply({
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [], other: 'Green please' }]
      })
    ).toEqual({ action: 'accept', content: { q1_other: 'Green please' } })
    expect(presentation?.reply({ kind: 'option', optionId: 'o1' })).toEqual({
      action: 'accept',
      content: { q1: '1' }
    })
    expect(presentation?.reply(null)).toEqual({ action: 'cancel' })
  })

  it('keeps the question as the heading of a lone multi-select card', () => {
    const toppings = { type: 'array', title: 'Pick toppings', items: { anyOf: question.oneOf } }
    expect(present(form('The agent has a question.', { q1: toppings }))?.body).toMatchObject({
      question: 'Pick toppings'
    })
  })

  it('leaves other forms, such as forwarded MCP requests, to the shared presentation', () => {
    expect(present(form('Choose a deployment target', { q1: question }))).toBeUndefined()
  })
})

it('reports known empty efforts for Orchestrator models and preserves family efforts when thought_level disappears', () => {
  const options = new AcpStructuredOptions(ANTIGRAVITY_ACP_DIALECT)
  const modelMenu = {
    id: 'model',
    name: 'Model',
    category: 'model' as const,
    type: 'select' as const,
    currentValue: 'gemini-4-carbon',
    options: [
      { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
      { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
      { value: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' }
    ]
  }
  options.adoptSession(
    NewSessionResponseSchema.parse({
      sessionId: 'agy-159',
      models: {
        currentModelId: 'gemini-4-carbon-medium',
        availableModels: [
          { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
          { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
          { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
          { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
          { modelId: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' }
        ]
      },
      configOptions: [
        modelMenu,
        {
          id: 'thought_level',
          name: 'Thinking Level',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' }
          ]
        }
      ]
    }),
    'new'
  )
  const efforts = () =>
    Object.fromEntries(
      options
        .read()
        .models.map((model) => [
          model.id,
          model.effortsKnown === false ? 'unknown' : model.efforts.map(({ value }) => value)
        ])
    )
  expect(efforts()).toEqual({
    'gemini-4-carbon': ['low', 'medium', 'high'],
    'gemini-pro-orchestrator': [],
    'gemini-pro-orchestrator-argon': []
  })
  // Selecting Orchestrator removes `thought_level` from `configOptions` on `agy acp`.
  options.adoptConfigOptions([{ ...modelMenu, currentValue: 'gemini-pro-orchestrator' }])
  expect(options.read().current).toEqual({
    model: 'gemini-pro-orchestrator',
    confirmed: ['model']
  })
  expect(efforts()).toEqual({
    'gemini-4-carbon': ['low', 'medium', 'high'],
    'gemini-pro-orchestrator': [],
    'gemini-pro-orchestrator-argon': []
  })
})

it('normalizes run_command output, surfaces Orchestrator plan documents, and attaches plan subjects on feedback approvals', () => {
  const translator = new AcpTimelineTranslator({
    sessionId: 'agy-plan',
    dialect: ANTIGRAVITY_ACP_DIALECT
  })
  translator.openPrompt('msg-1', 100)
  const cmdEvents = translator.notification(
    'session/update',
    {
      sessionId: 'agy-plan',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_cmd',
        kind: 'execute',
        status: 'completed',
        rawInput: { CommandLine: 'pnpm tc' },
        rawOutput: { output: 'all clean', exit_code: 0 }
      }
    },
    110
  )
  expect(cmdEvents).toContainEqual(
    expect.objectContaining({
      type: 'item.close',
      body: expect.objectContaining({
        kind: 'tool-call',
        name: 'execute',
        input: { command: 'pnpm tc' },
        output: expect.objectContaining({ head: 'all clean', truncated: false }),
        exitCode: 0
      })
    })
  )

  const planEvents = translator.notification(
    'session/update',
    {
      sessionId: 'agy-plan',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_plan',
        name: 'exit_plan_mode',
        status: 'completed',
        rawInput: { plan: '## Phase 1 Plan\n- Step A' }
      }
    },
    120
  )
  expect(planEvents).toContainEqual(
    expect.objectContaining({
      type: 'item.update',
      item: 'plan-tool:call_plan',
      body: {
        kind: 'status',
        presentation: 'plan-document',
        text: '## Phase 1 Plan\n- Step A'
      }
    })
  )

  const artifactApproval = translator.request(
    'session/request_permission',
    {
      sessionId: 'agy-plan',
      toolCall: {
        toolCallId: 'call_write_plan',
        name: 'write_file',
        title: 'Write implementation_plan.md',
        rawInput: {
          Path: '/Users/neo/.gemini/antigravity-cli/brain/s1/implementation_plan.md',
          Content: '# Implementation Plan\n1. Update launch spec',
          ArtifactMetadata: {
            RequestFeedback: true,
            Summary: 'Plan summary',
            UserFacing: true
          }
        }
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ]
    },
    7
  )
  expect(artifactApproval.presentation?.body).toMatchObject({
    kind: 'approval',
    subject: {
      kind: 'plan',
      text: '# Implementation Plan\n1. Update launch spec',
      filePath: '/Users/neo/.gemini/antigravity-cli/brain/s1/implementation_plan.md'
    }
  })

  const exitPlanApproval = translator.request(
    'session/request_permission',
    {
      sessionId: 'agy-plan',
      toolCall: {
        toolCallId: 'call_exit_plan',
        name: 'exit_plan_mode',
        title: 'Run exit_plan_mode',
        rawInput: { plan: '# Orchestrator Plan\n- Execute phase 2' }
      },
      options: [
        {
          optionId: 'allow_always',
          name: 'Allow Always',
          kind: 'allow_always',
          _meta: { 'agy.security.warning': { message: 'Auto-approves future plans' } }
        },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ]
    },
    8
  )
  expect(exitPlanApproval.presentation?.body).toMatchObject({
    kind: 'approval',
    description: 'Auto-approves future plans',
    subject: {
      kind: 'plan',
      text: '# Orchestrator Plan\n- Execute phase 2'
    }
  })
})

it('tracks Antigravity invoke_subagent, manage_subagents, and swarm lifecycles and settles remaining subagents at turn end', () => {
  const translator = new AcpTimelineTranslator({
    sessionId: 'agy-orch',
    dialect: ANTIGRAVITY_ACP_DIALECT
  })
  translator.openPrompt('msg-orch', 200)
  translator.notification(
    'session/update',
    {
      sessionId: 'agy-orch',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_sub_1',
        name: 'invoke_subagent',
        title: 'Run invoke_subagent',
        status: 'in_progress',
        rawInput: {
          TypeName: 'research',
          Model: 'flash_lite',
          Role: 'Quick Checker',
          Prompt: 'Inspect specs'
        }
      }
    },
    210
  )
  translator.notification(
    'session/update',
    {
      sessionId: 'agy-orch',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_swarm_add',
        name: 'swarm',
        status: 'completed',
        rawInput: {
          action: 'add',
          name: 'verifier',
          tasks: ['unit', 'lint'],
          brief: 'Verify gates'
        }
      }
    },
    220
  )
  expect(translator.subagents.drainEvidence()).toEqual([
    expect.objectContaining({
      type: 'live',
      observedAt: 210,
      child: expect.objectContaining({
        handle: { idKind: 'task_id', id: 'call_sub_1' },
        kind: 'agent',
        state: 'working',
        description: 'Quick Checker (flash_lite)'
      })
    }),
    expect.objectContaining({
      type: 'live',
      observedAt: 220,
      child: expect.objectContaining({
        handle: { idKind: 'task_id', id: 'swarm:verifier-1' },
        state: 'working',
        description: 'verifier-1: unit'
      })
    }),
    expect.objectContaining({
      type: 'live',
      observedAt: 220,
      child: expect.objectContaining({
        handle: { idKind: 'task_id', id: 'swarm:verifier-2' },
        state: 'working',
        description: 'verifier-2: lint'
      })
    })
  ])

  // Killing a named swarm worker transitions it immediately to cancelled.
  translator.notification(
    'session/update',
    {
      sessionId: 'agy-orch',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_swarm_kill',
        name: 'swarm',
        status: 'completed',
        rawInput: { action: 'kill', name: 'verifier-1' }
      }
    },
    230
  )
  expect(translator.subagents.drainEvidence()).toEqual([
    {
      type: 'ended',
      observedAt: 230,
      handle: { idKind: 'task_id', id: 'swarm:verifier-1' },
      outcome: 'cancelled'
    }
  ])

  // Ending the parent `session/prompt` settles remaining turn-bound subagents cleanly.
  translator.promptResult('msg-orch', { stopReason: 'end_turn' }, 250)
  expect(translator.subagents.drainEvidence()).toEqual([
    {
      type: 'ended',
      observedAt: 250,
      handle: { idKind: 'task_id', id: 'call_sub_1' },
      outcome: 'succeeded'
    },
    {
      type: 'ended',
      observedAt: 250,
      handle: { idKind: 'task_id', id: 'swarm:verifier-2' },
      outcome: 'succeeded'
    }
  ])
})
