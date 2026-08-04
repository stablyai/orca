export const mobileNativeChatImageErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
