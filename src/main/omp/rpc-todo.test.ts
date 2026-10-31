import { describe, expect, it } from 'vitest'
import { decodeOmpTranscriptLine } from '../native-chat/transcript-line-decoders-omp'
import { ompTodoEvents, ompTodoInputPlan } from './rpc-todo'

const phases = [
  {
    name: 'Build',
    tasks: [
      { content: 'Implement adapter', status: 'in_progress' },
      { content: 'Run checks', status: 'blocked', blocker: 'Provider quota' },
      { content: 'Old idea', status: 'abandoned' },
      { content: 'Ship', status: 'completed' }
    ]
  }
]

describe('OMP Todo projection', () => {
  it('projects an init call before its committed result arrives', () => {
    const [event] = ompTodoEvents({
      type: 'tool_execution_start',
      toolCallId: 'todo-start',
      toolName: 'todo',
      args: {
        op: 'init',
        items: ['Clarify requirements', 'Write the report'],
        list: []
      }
    })
    expect(event).toMatchObject({
      type: 'item.open',
      item: 'tool:todo-start',
      body: {
        kind: 'tool-call',
        name: 'update_plan',
        state: 'running',
        input: {
          plan: [
            { step: 'Todo: Clarify requirements', status: 'pending' },
            { step: 'Todo: Write the report', status: 'pending' }
          ]
        }
      }
    })
  })

  it('uses phase entries when OMP includes them in the call arguments', () => {
    expect(
      ompTodoInputPlan({
        op: 'init',
        items: [],
        list: [{ phase: 'Discovery', items: ['Inspect the protocol'] }]
      })
    ).toEqual({
      plan: [{ step: 'Discovery: Inspect the protocol', status: 'pending' }],
      explanation: 'OMP phases: Discovery'
    })
  })

  it('maps native phases to the existing three task statuses without counting blocked work as done', () => {
    const [event] = ompTodoEvents({
      type: 'tool_execution_end',
      toolCallId: 'todo-1',
      toolName: 'todo',
      result: { content: [], details: { phases } }
    })
    expect(event).toMatchObject({
      item: 'tool:todo-1',
      body: {
        kind: 'tool-call',
        name: 'update_plan',
        input: {
          plan: [
            { status: 'in_progress' },
            { status: 'pending', step: 'Build: Run checks (blocked: Provider quota)' },
            { status: 'pending', step: 'Build: Old idea (abandoned)' },
            { status: 'completed' }
          ]
        }
      }
    })
  })

  it('projects Todo details from historical OMP tool results', () => {
    const decoded = decodeOmpTranscriptLine(
      JSON.stringify({
        type: 'message',
        id: 'todo-result',
        message: { role: 'toolResult', toolName: 'todo', content: [], details: { phases } }
      }),
      'todo-result'
    )
    const todo = decoded?.blocks.find((block) => block.type === 'tool-call')
    expect(todo).toMatchObject({ type: 'tool-call', name: 'update_plan' })
    expect(todo?.type === 'tool-call' ? todo.input : null).toMatchObject({
      plan: expect.arrayContaining([expect.objectContaining({ status: 'in_progress' })])
    })
  })
})
