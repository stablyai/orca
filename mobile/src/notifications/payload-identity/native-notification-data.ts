export function readNativeNotificationData(request: {
  content: { data?: unknown; dataString?: unknown }
  trigger?: unknown
}): unknown {
  const trigger = request.trigger
  if (trigger && typeof trigger === 'object' && 'type' in trigger && trigger.type === 'push') {
    // Expo iOS keeps raw APNs custom fields here when content.data is null.
    if ('payload' in trigger && trigger.payload && typeof trigger.payload === 'object') {
      return trigger.payload
    }
  }
  if (request.content.data != null) {
    return request.content.data
  }
  // Headless tasks receive native responses before Expo maps dataString into data.
  if (typeof request.content.dataString === 'string') {
    try {
      return JSON.parse(request.content.dataString)
    } catch {
      return null
    }
  }
  if (
    trigger &&
    typeof trigger === 'object' &&
    'type' in trigger &&
    trigger.type === 'push' &&
    'remoteMessage' in trigger &&
    trigger.remoteMessage &&
    typeof trigger.remoteMessage === 'object' &&
    'data' in trigger.remoteMessage
  ) {
    return trigger.remoteMessage.data
  }
  return request.content.data
}
