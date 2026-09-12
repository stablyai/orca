export function canCancelMobileStructuredPrompt(input: {
  turnId: string | null
  permission: unknown | null
  question: unknown | null
}): boolean {
  return input.turnId !== null || input.permission !== null || input.question !== null
}
