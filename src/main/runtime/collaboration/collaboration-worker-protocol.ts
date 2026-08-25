// Why: pure text builder for the collaboration section of a dispatched
// worker's protocol. Topology-derived topic grants plus terminal identity
// in, a self-contained publish/subscribe playbook out; no I/O, so the
// emitted text is unit-testable word-for-word.

export type CollaborationWorkerProtocolInput = {
  cli: string
  workerHandle: string
  dispatchCapability?: string
  publishesTo: readonly string[]
  requiredPublishesTo: readonly string[]
  subscribesTo: readonly string[]
}

export function buildCollaborationWorkerProtocol(input: CollaborationWorkerProtocolInput): string {
  const sections = [buildPublisherSection(input), buildSubscriberSection(input)].filter(
    (section): section is string => section !== null
  )
  return sections.length === 0 ? '' : sections.join('\n\n')
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
  const requiredBlock =
    requiredPublishesTo.length > 0
      ? `REQUIRED publish topics - each MUST return "Published ..." before worker_done:
${topicList(requiredPublishesTo)}

Required topics gate completion: every required topic above must successfully
return "Published <id> to N subscriber(s)." before you send worker_done.`
      : ''
  return `=== COLLABORATION: PUBLISHER ===

${[allowedBlock, requiredBlock].filter((block) => block !== '').join('\n\n')}

Publish one message per call (replace <topic> and <body>):
  ${cli} orchestration collaboration-publish --from ${workerHandle}${capability} \\
    --topic <topic> --semantic-type finding --priority normal \\
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

Before worker_done: if required context is missing, run exactly one blocking
checkpoint:
  ${cli} orchestration collaboration-checkpoint --from ${workerHandle}${capability} \\
    --wait --timeout-ms 60000

If context is still missing after that single blocking wait, do not report success;
escalate to the coordinator.

Acknowledge message ids only after you have incorporated them:
  ${cli} orchestration collaboration-ack --from ${workerHandle}${capability} \\
    --message-ids "<JSON array of message ids printed by checkpoint>"

Do not add task-id, dispatch-id, or publication-id flags; collaboration
identity comes from --from.`
}

function topicList(topics: readonly string[]): string {
  return topics.map((topic) => `  - ${topic}`).join('\n')
}

function capabilityFlag(input: CollaborationWorkerProtocolInput): string {
  return input.dispatchCapability ? ` --dispatch-capability ${input.dispatchCapability}` : ''
}
