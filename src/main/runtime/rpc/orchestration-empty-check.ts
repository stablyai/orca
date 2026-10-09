export function isEmptyConsumingCheck(method: string, params: unknown, result: unknown): boolean {
  if (
    method !== 'orchestration.check' ||
    !params ||
    typeof params !== 'object' ||
    !result ||
    typeof result !== 'object'
  ) {
    return false
  }
  // An acknowledged batch or a delivery still needs its replay record, even with no visible mail.
  return (
    !('ack' in params && params.ack !== undefined) &&
    !('peek' in params && params.peek === true) &&
    !('all' in params && params.all === true) &&
    !('unread' in params && params.unread === false) &&
    'messages' in result &&
    Array.isArray(result.messages) &&
    result.messages.length === 0 &&
    'count' in result &&
    result.count === 0 &&
    (!('acknowledged' in result) || result.acknowledged === null) &&
    (!('deliveryId' in result) || result.deliveryId === null)
  )
}
