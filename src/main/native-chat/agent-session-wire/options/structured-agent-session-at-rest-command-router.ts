import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'

export function createStructuredAgentAtRestCommandRouter(
  sourceFor: (provider: string) => StructuredAgentSessionAtRestCommands | undefined,
  sources: () => readonly StructuredAgentSessionAtRestCommands[]
): StructuredAgentSessionAtRestCommands {
  return {
    read: (record) => sourceFor(record.provider)?.read(record),
    snapshot: (record) =>
      sourceFor(record.provider)?.snapshot?.(record) ?? {
        commandsPending: false
      },
    settled: async (record, budgetMs, independent) => {
      const source = sourceFor(record.provider)
      return source?.settled ? source.settled(record, budgetMs, independent) : source?.read(record)
    },
    onChange: (listener) => {
      const stops = sources().map((source) => source.onChange(listener))
      return () => stops.forEach((stop) => stop())
    }
  }
}
