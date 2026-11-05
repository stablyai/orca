export function readNativeNotificationData(request: {
  content: { data?: unknown }
  trigger?: unknown
}): unknown {
  const trigger = request.trigger
  if (trigger && typeof trigger === 'object' && 'type' in trigger && trigger.type === 'push') {
    // Expo iOS keeps raw APNs custom fields here when content.data is null.
    if ('payload' in trigger && trigger.payload && typeof trigger.payload === 'object') {
      return trigger.payload
    }
  }
  return request.content.data
}
