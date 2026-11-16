export function sendDeliveryOutput(value: {
  deliveryMessage?: string
  deliveryHint?: string | null
}): string {
  const receipt = value as Record<string, unknown>
  const deliveries = Array.isArray(receipt.deliveries)
    ? receipt.deliveries
    : Array.isArray(receipt.messages)
      ? receipt.messages.map((message) => ({
          message,
          deliveryMessage: receipt.deliveryMessage,
          target: { address: message.to_handle }
        }))
      : [receipt]
  const lines: string[] = []
  for (const delivery of deliveries) {
    if (delivery.deliveryMessage) {
      lines.push(delivery.deliveryMessage)
    }
    if (delivery.deliveryHint) {
      lines.push(delivery.deliveryHint)
    }
    const message = delivery?.message
    const target = delivery?.target?.address ?? message?.to_handle
    const messageId = message?.id ?? delivery?.relay?.messageId
    if (messageId) {
      lines.push(`Message: ${messageId}${target ? ` · Target: ${target}` : ''}`)
    }
  }
  return lines.join('\n')
}

export function unconfirmedSendReceipt(
  value: Record<string, unknown>,
  recipient: string | undefined
) {
  return {
    ...value,
    delivered: false,
    state: 'unknown',
    reason: { kind: 'delivery_unconfirmed' },
    target: { address: recipient },
    deliveryMessage: 'Message kept. Delivery is unconfirmed.'
  }
}
