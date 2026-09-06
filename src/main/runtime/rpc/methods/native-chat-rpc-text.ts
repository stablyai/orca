const TRUNCATION_MARKER = '\n… (truncated)'

export const truncateNativeChatRpcText = (text: string, cap: number): string =>
  text.length > cap ? text.slice(0, cap) + TRUNCATION_MARKER : text
