export function readNotificationReplyDraftRecord(
  raw: string
): ({ text: string } & Record<string, unknown>) | null {
  try {
    const saved: unknown = JSON.parse(raw)
    if (
      !saved ||
      typeof saved !== 'object' ||
      !('text' in saved) ||
      typeof saved.text !== 'string' ||
      ('restored' in saved && saved.restored === true)
    ) {
      return null
    }
    return { ...saved, text: saved.text }
  } catch {
    return null
  }
}
