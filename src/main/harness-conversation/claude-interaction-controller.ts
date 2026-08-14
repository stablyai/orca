import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { HarnessConversationDriverSink } from './driver'
import { parseClaudeQuestions } from './claude-message'

export class ClaudeInteractionController {
  private readonly permissions = new Map<string, (optionId: string) => void>()
  private readonly inputs = new Map<string, (answers: Record<string, string[]> | null) => void>()

  constructor(private readonly sink: HarnessConversationDriverSink) {}

  request: CanUseTool = (toolName, input, options) => {
    if (toolName === 'AskUserQuestion') {
      return this.requestInput(input, options)
    }
    const id = options.requestId || randomUUID()
    return new Promise((resolve) => {
      const finish = (optionId: string): void => {
        this.permissions.delete(id)
        options.signal.removeEventListener('abort', onAbort)
        this.sink.emit({ type: 'permission', permission: null })
        resolve(permissionResult(optionId, input, options))
      }
      const onAbort = (): void => finish('reject')
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.permissions.set(id, finish)
      this.sink.emit({
        type: 'permission',
        permission: {
          id,
          title: options.title ?? `${toolName} requests permission`,
          detail: options.description ?? JSON.stringify(input, null, 2),
          options: [
            { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
            ...(options.suggestions?.length
              ? [{ id: 'allow-always', label: 'Always allow', kind: 'allow-always' as const }]
              : []),
            { id: 'reject', label: 'Reject', kind: 'reject' }
          ]
        }
      })
    })
  }

  answerPermission(requestId: string, optionId: string): void {
    this.permissions.get(requestId)?.(optionId)
  }

  answerInput(requestId: string, answers: Record<string, string[]>): void {
    this.inputs.get(requestId)?.(answers)
  }

  cancel(): void {
    for (const finish of this.permissions.values()) {
      finish('reject')
    }
    for (const finish of this.inputs.values()) {
      finish(null)
    }
  }

  private requestInput(
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2]
  ): Promise<PermissionResult> {
    const questions = parseClaudeQuestions(input.questions)
    if (!questions.length) {
      return Promise.reject(new Error('claude_input_invalid'))
    }
    const id = options.requestId || randomUUID()
    return new Promise((resolve) => {
      const finish = (answers: Record<string, string[]> | null): void => {
        this.inputs.delete(id)
        options.signal.removeEventListener('abort', onAbort)
        this.sink.emit({ type: 'input', input: null })
        resolve(
          answers
            ? {
                behavior: 'allow',
                updatedInput: {
                  ...input,
                  answers: Object.fromEntries(
                    Object.entries(answers).map(([question, values]) => [
                      question,
                      values.join(', ')
                    ])
                  )
                },
                decisionClassification: 'user_temporary'
              }
            : {
                behavior: 'deny',
                message: 'Cancelled by user',
                decisionClassification: 'user_reject'
              }
        )
      }
      const onAbort = (): void => finish(null)
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.inputs.set(id, finish)
      this.sink.emit({ type: 'input', input: { id, questions } })
    })
  }
}

function permissionResult(
  optionId: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2]
): PermissionResult {
  return optionId === 'allow-once' || optionId === 'allow-always'
    ? {
        behavior: 'allow',
        updatedInput: input,
        ...(optionId === 'allow-always' && options.suggestions
          ? { updatedPermissions: options.suggestions }
          : {}),
        decisionClassification: optionId === 'allow-always' ? 'user_permanent' : 'user_temporary'
      }
    : {
        behavior: 'deny',
        message: 'Rejected by user',
        decisionClassification: 'user_reject'
      }
}
