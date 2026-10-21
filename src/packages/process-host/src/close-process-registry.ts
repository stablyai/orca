export async function closeProcessRegistry(input: {
  attempts: number
  hasEntries: () => boolean
  entryIds: () => Iterable<string>
  closeEntry: (id: string) => Promise<boolean>
  failureMessage: string
}): Promise<void> {
  const errors: unknown[] = []
  for (let attempt = 0; attempt < input.attempts && input.hasEntries(); attempt += 1) {
    await Promise.all(
      [...input.entryIds()].map(async (id) => {
        try {
          await input.closeEntry(id)
        } catch (error) {
          errors.push(error)
        }
      })
    )
  }
  if (!input.hasEntries()) {
    return
  }
  throw errors.length > 0
    ? new AggregateError(errors, input.failureMessage)
    : new Error(input.failureMessage)
}
