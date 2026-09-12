export type CollaborationRoutingStep = {
  key: string
  readonly subscribesTo?: readonly string[]
}

export function getCollaboratorsForTopic(
  steps: readonly CollaborationRoutingStep[],
  topic: string
): string[] {
  const collaborators: string[] = []
  for (const step of steps) {
    const subscriptions = step.subscribesTo
    if (!subscriptions) {
      continue
    }
    for (const subscribedTopic of subscriptions) {
      if (subscribedTopic === topic && !collaborators.includes(step.key)) {
        collaborators.push(step.key)
      }
    }
  }
  return collaborators
}
