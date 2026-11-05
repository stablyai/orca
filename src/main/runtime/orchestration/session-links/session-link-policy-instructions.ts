import type { SessionLink } from '../../../../shared/session-link'

export function sessionLinkPolicyInstructions(link: SessionLink): string {
  const limit = link.policy
    ? link.policy.turnLimit === null
      ? 'There is no fixed automatic turn limit. Continue useful collaboration until the reviewer accepts the result, an owner decision is needed, or a participant ends the link. '
      : `The owner selected a limit of ${link.policy.turnLimit} automatic agent wake-ups, including introductions, before owner continuation. `
    : 'This legacy link pauses after 6 automatic agent wake-ups or 12 agent messages. The owner can change this policy in Collaboration limits. '
  return `${
    limit
  }The implementer sends checkpoints and waits for correlated review. The reviewer requests corrections while work remains; when the shared story is accepted, end the link with a concise acceptance summary using --summary. Do not stop merely because one subtask is complete. Repeated messages still pause the link. `
}
