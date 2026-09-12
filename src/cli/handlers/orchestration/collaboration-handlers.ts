import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import {
  resolveCoordinatorTerminalHandle,
  resolveOrchestrationTerminalHandle
} from './terminal-identity'

const COLLABORATION_PRIORITIES = ['normal', 'high', 'urgent'] as const
type CollaborationPriority = (typeof COLLABORATION_PRIORITIES)[number]

const COLLABORATION_CHECKPOINT_LIMIT_MAX = 100
const COLLABORATION_CHECKPOINT_TIMEOUT_MS_MAX = 600_000
const COLLABORATION_ACK_MESSAGE_IDS_MAX = 100
const COLLABORATION_STEPS_MAX = 64
const COLLABORATION_TOPICS_MAX = 32

type CollaborationPublishResult = {
  publicationId: string
  messageIds: string[]
  subscriberTaskIds: string[]
}

type CollaborationCheckpointEntry = {
  messageId: string
  topic: string
  semanticType: string
  producerTaskId: string
  priority: CollaborationPriority
  body: string
}

type CollaborationCheckpointResult = {
  entries: CollaborationCheckpointEntry[]
  filteredMessageIds: string[]
  timedOut: boolean
  cancelled: boolean
}

type CollaborationAckResult = {
  messageIds: string[]
  duplicate: boolean
}

type CollaborationConfigureResult = {
  runId: string
  stepCount: number
}

function getCollaborationPriority(flags: Map<string, string | boolean>): CollaborationPriority {
  const priority = getOptionalStringFlag(flags, 'priority') ?? 'normal'
  if (!(COLLABORATION_PRIORITIES as readonly string[]).includes(priority)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--priority must be one of: ${COLLABORATION_PRIORITIES.join(', ')}`
    )
  }
  return priority as CollaborationPriority
}

function getBoundedPositiveIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string,
  max: number
): number | undefined {
  const value = getOptionalPositiveIntegerValueFlag(flags, name)
  if (value !== undefined && value > max) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be at most ${max}`)
  }
  return value
}

function getCollaborationCapabilityOption(
  flags: Map<string, string | boolean>
): { orchestrationCapability: string } | undefined {
  const capability = getOptionalStringFlag(flags, 'dispatch-capability')
  return capability ? { orchestrationCapability: capability } : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCollaborationTopicList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= COLLABORATION_TOPICS_MAX &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  )
}

function validateCollaborationAdmission(admission: unknown): void {
  if (
    !isRecord(admission) ||
    !Array.isArray(admission.acceptedTypes) ||
    admission.acceptedTypes.length < 1 ||
    admission.acceptedTypes.length > COLLABORATION_TOPICS_MAX ||
    !admission.acceptedTypes.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--steps admission.acceptedTypes must be a JSON array of 1..${COLLABORATION_TOPICS_MAX} non-empty strings.`
    )
  }
  if (!(COLLABORATION_PRIORITIES as readonly string[]).includes(admission.minPriority as string)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--steps admission.minPriority must be one of: normal, high, urgent.'
    )
  }
}

function validateCollaborationStep(step: unknown): void {
  if (!isRecord(step) || typeof step.taskId !== 'string' || step.taskId.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--steps entries must be objects with a non-empty string taskId.'
    )
  }
  for (const field of ['publishesTo', 'requiredPublishesTo', 'subscribesTo'] as const) {
    if (step[field] !== undefined && !isCollaborationTopicList(step[field])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--steps ${field} must be a JSON array of at most ${COLLABORATION_TOPICS_MAX} non-empty strings.`
      )
    }
  }
  if (step.admission !== undefined) {
    validateCollaborationAdmission(step.admission)
  }
}

function getCollaborationSteps(flags: Map<string, string | boolean>): unknown {
  const raw = getRequiredStringFlag(flags, 'steps')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > COLLABORATION_STEPS_MAX) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--steps must be a JSON array of 1..${COLLABORATION_STEPS_MAX} step objects.`
    )
  }
  for (const step of parsed) {
    validateCollaborationStep(step)
  }
  return parsed
}

function getCollaborationMessageIds(flags: Map<string, string | boolean>): string[] {
  const raw = getRequiredStringFlag(flags, 'message-ids')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length >= 1 &&
    parsed.length <= COLLABORATION_ACK_MESSAGE_IDS_MAX &&
    parsed.every((entry) => typeof entry === 'string' && entry.length > 0)
  if (!valid) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--message-ids must be a JSON array of 1..${COLLABORATION_ACK_MESSAGE_IDS_MAX} non-empty strings.`
    )
  }
  return parsed as string[]
}

export const ORCHESTRATION_COLLABORATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration collaboration-publish': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<CollaborationPublishResult>(
      client,
      flags,
      'orchestration.collaborationPublish',
      {
        from,
        topic: getRequiredStringFlag(flags, 'topic'),
        semanticType: getRequiredStringFlag(flags, 'semantic-type'),
        priority: getCollaborationPriority(flags),
        body: getRequiredStringFlagAllowingEmpty(flags, 'body')
      },
      getCollaborationCapabilityOption(flags)
    )
    printResult(result, json, (value) => {
      return `Published ${value.publicationId} to ${value.subscriberTaskIds.length} subscriber(s).`
    })
  },

  'orchestration collaboration-checkpoint': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const wait = flags.has('wait')
    const result = await callOrchestrationMutation<CollaborationCheckpointResult>(
      client,
      flags,
      'orchestration.collaborationCheckpoint',
      {
        from,
        limit: getBoundedPositiveIntegerFlag(flags, 'limit', COLLABORATION_CHECKPOINT_LIMIT_MAX),
        wait: wait ? true : undefined,
        timeoutMs: getBoundedPositiveIntegerFlag(
          flags,
          'timeout-ms',
          COLLABORATION_CHECKPOINT_TIMEOUT_MS_MAX
        )
      },
      getCollaborationCapabilityOption(flags)
    )
    printResult(result, json, (value) => {
      if (value.entries.length === 0) {
        if (value.timedOut) {
          return 'Timed out waiting for collaboration context.'
        }
        if (value.cancelled) {
          return 'Collaboration checkpoint cancelled.'
        }
        return 'No collaboration context.'
      }
      return value.entries
        .map(
          (entry) =>
            `message ${entry.messageId} ${entry.topic} ${entry.semanticType} ${entry.priority} ` +
            `producer=${entry.producerTaskId}\n${JSON.stringify(entry.body)}`
        )
        .join('\n')
    })
  },

  'orchestration collaboration-configure': async ({ flags, client, cwd, json }) => {
    // Why: parse before identity resolution so malformed --steps never triggers an RPC.
    const steps = getCollaborationSteps(flags)
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<CollaborationConfigureResult>(
      client,
      flags,
      'orchestration.collaborationConfigure',
      {
        run: getOptionalStringFlag(flags, 'run'),
        from,
        steps
      }
    )
    printResult(result, json, (value) => {
      return `Configured collaboration for Run ${value.runId}: ${value.stepCount} step(s).`
    })
  },

  'orchestration collaboration-ack': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<CollaborationAckResult>(
      client,
      flags,
      'orchestration.collaborationAck',
      {
        from,
        messageIds: getCollaborationMessageIds(flags)
      },
      getCollaborationCapabilityOption(flags)
    )
    printResult(result, json, (value) => {
      const line = `Acknowledged ${value.messageIds.length} collaboration message(s).`
      return value.duplicate ? `${line} (replay)` : line
    })
  }
}
