// Why: pure text builder for the collaboration section of a dispatched
// worker's protocol. Topology-derived topic grants plus terminal identity
// in, a self-contained publish/subscribe playbook out; no I/O, so the
// emitted text is unit-testable word-for-word.

import type { OrchestrationCliCommand } from '../orchestration/cli-command'
import {
  admittedPublishOptionsForTopic,
  type CollaborationPublishAdmissionOption,
  type CollaborationTopology
} from './collaboration-topology'

export type CollaborationRequiredPublishAdmission = {
  topic: string
  options: readonly CollaborationPublishAdmissionOption[]
}

export type CollaborationWorkerProtocolInput = {
  cli: string
  workerHandle: string
  dispatchCapability?: string
  publishesTo: readonly string[]
  requiredPublishesTo: readonly string[]
  requiredPublishAdmission?: readonly CollaborationRequiredPublishAdmission[]
  subscribesTo: readonly string[]
}

export type CollaborationWorkerTaskProtocolInput = {
  topology: CollaborationTopology | undefined
  taskId: string
  workerHandle: string
  dispatchCapability?: string
  devMode?: boolean
  // Runtime-selected command for Orca-managed terminals. Managed PTY envs pin
  // this to the current bundled/dev CLI across local, WSL, and SSH execution.
  cliCommand?: OrchestrationCliCommand
}

export function buildCollaborationWorkerProtocol(input: CollaborationWorkerProtocolInput): string {
  const sections = [buildPublisherSection(input), buildSubscriberSection(input)].filter(
    (section): section is string => section !== null
  )
  return sections.length === 0 ? '' : sections.join('\n\n')
}

export function buildCollaborationWorkerProtocolForTask(
  input: CollaborationWorkerTaskProtocolInput
): string | undefined {
  const step = input.topology?.steps.find((candidate) => candidate.taskId === input.taskId)
  if (!step) {
    return undefined
  }
  const requiredPublishesTo = step.requiredPublishesTo ?? []
  const protocol = buildCollaborationWorkerProtocol({
    cli: input.cliCommand ?? (input.devMode ? 'orca-dev' : 'orca'),
    workerHandle: input.workerHandle,
    dispatchCapability: input.dispatchCapability,
    publishesTo: step.publishesTo ?? [],
    requiredPublishesTo,
    requiredPublishAdmission: requiredPublishesTo.map((topic) => ({
      topic,
      options: admittedPublishOptionsForTopic(input.topology!, topic)
    })),
    subscribesTo: step.subscribesTo ?? []
  })
  return protocol === '' ? undefined : protocol
}

function buildPublisherSection(input: CollaborationWorkerProtocolInput): string | null {
  const { cli, workerHandle, publishesTo, requiredPublishesTo } = input
  if (publishesTo.length === 0 && requiredPublishesTo.length === 0) {
    return null
  }
  const capability = capabilityFlag(input)
  const allowedBlock =
    publishesTo.length > 0
      ? `Allowed publish topics (granted by the Run topology):
${topicList(publishesTo)}`
      : ''
  const admissionGuidance =
    input.requiredPublishAdmission === undefined
      ? ''
      : `\n\nFor each required topic, choose one of the admitted semantic-type / minimum-priority
combinations shown above. A higher priority than the listed minimum is also valid.`
  const zeroSubscriberRecovery =
    input.requiredPublishAdmission === undefined
      ? 'retry with a task-appropriate semantic type/priority or escalate to the coordinator.'
      : 'if no admitted combination is shown, or every valid attempt reaches zero subscribers, escalate to the coordinator.'
  const requiredBlock =
    requiredPublishesTo.length > 0
      ? `REQUIRED publish topics - each MUST return "Published ..." before worker_done:
${requiredTopicList(requiredPublishesTo, input.requiredPublishAdmission)}${admissionGuidance}

Required topics gate completion: every required topic above must successfully
return "Published <id> to N subscriber(s)." with N >= 1 before you send worker_done.
"Published <id> to 0 subscriber(s)." does not satisfy a required topic; ${zeroSubscriberRecovery}`
      : ''
  return `=== COLLABORATION: PUBLISHER ===

${[allowedBlock, requiredBlock].filter((block) => block !== '').join('\n\n')}

Publish one message per call (replace placeholders with task-appropriate values):
  ${cli} orchestration collaboration-publish --from ${workerHandle}${capability} \\
    --topic <topic> --semantic-type <semantic-type> --priority <priority> \\
    --body "<message body>"

Subscribers are topology-derived and never named by the publisher: the Run
topology decides who receives each topic; collaboration-publish has no
subscriber flags.

If a publish returns an unknown mutation result, retry the exact command with
--retry-request <id>, using the retry id printed by Orca. Never invent a publication id:
only Orca can mint one, so retry the exact same command verbatim with its id.

Do not add task-id, dispatch-id, or publication-id flags; collaboration
identity comes from --from.`
}

function buildSubscriberSection(input: CollaborationWorkerProtocolInput): string | null {
  const { cli, workerHandle, subscribesTo } = input
  if (subscribesTo.length === 0) {
    return null
  }
  const capability = capabilityFlag(input)
  return `=== COLLABORATION: SUBSCRIBER ===

You are subscribed to these topics:
${topicList(subscribesTo)}

At safe stage boundaries, consume new collaboration context without blocking:
  ${cli} orchestration collaboration-checkpoint --from ${workerHandle}${capability}

Never poll or sleep-loop waiting for context; checkpoint is event-driven.

Before worker_done, use the TASK instructions to build a missing-context checklist.
When checklist items are still missing, run one blocking checkpoint at a time:
  ${cli} orchestration collaboration-checkpoint --from ${workerHandle}${capability} \\
    --wait --timeout-ms 60000

After each admitted batch, incorporate it and ACK its message ids, then remove satisfied
items from the checklist. If concrete required context is still missing, you may run
another blocking checkpoint. Never keep more than one blocking checkpoint outstanding
and never replace it with a sleep/poll loop.

If a blocking checkpoint times out, is cancelled, returns no useful admitted context,
or does not reduce the missing-context checklist, do not report success; escalate to the
coordinator. Treat any checkpoint RPC error, including waiter_exists, the same way: do not
retry-loop it; escalate.

Acknowledge message ids only after you have incorporated them:
  ${cli} orchestration collaboration-ack --from ${workerHandle}${capability} \\
    --message-ids "<JSON array of message ids printed by checkpoint>"

Do not add task-id, dispatch-id, or publication-id flags; collaboration
identity comes from --from.`
}

function topicList(topics: readonly string[]): string {
  return topics.map((topic) => `  - ${topic}`).join('\n')
}

function requiredTopicList(
  topics: readonly string[],
  guidance: readonly CollaborationRequiredPublishAdmission[] | undefined
): string {
  const byTopic = new Map(guidance?.map((entry) => [entry.topic, entry.options]) ?? [])
  return topics
    .map((topic) => {
      const options = byTopic.get(topic)
      if (options === undefined) {
        return `  - ${topic}`
      }
      if (options.length === 0) {
        return `  - ${topic}\n    - no admitted semantic type / priority; escalate`
      }
      return `  - ${topic}\n${options
        .map(
          (option) =>
            `    - semantic-type ${option.semanticType}; minimum priority ${option.minPriority}`
        )
        .join('\n')}`
    })
    .join('\n')
}

function capabilityFlag(input: CollaborationWorkerProtocolInput): string {
  return input.dispatchCapability ? ` --dispatch-capability ${input.dispatchCapability}` : ''
}
