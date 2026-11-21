export type UsageWidgetStorage = {
  read(): string | null
  write(json: string): void
}

// Only iOS has a home screen widget.
export const usageWidgetStorage: UsageWidgetStorage | null = null
