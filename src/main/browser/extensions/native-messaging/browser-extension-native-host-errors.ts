/** Chrome's exact runtime.lastError messages for native messaging (native_message_host.cc). */
export const NATIVE_HOST_ERRORS = {
  invalidName: 'Invalid native messaging host name specified.',
  notFound: 'Specified native messaging host not found.',
  forbidden: 'Access to the specified native messaging host is forbidden.',
  failedToStart: 'Failed to start native messaging host.',
  exited: 'Native host has exited.',
  io: 'Error when communicating with the native messaging host.'
} as const
