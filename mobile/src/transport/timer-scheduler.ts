// The injected-timer seam's real contract: `typeof setTimeout` additionally demands
// Node's `__promisify__` member, which no injected timer (or safe wrapper) can supply.
export type ScheduleTimer = (handler: () => void, ms: number) => ReturnType<typeof setTimeout>

// Why: browsers throw Illegal invocation when a global timer is called with a non-global receiver; Hermes does not.
export const defaultScheduleTimer: ScheduleTimer = (handler, ms) => setTimeout(handler, ms)
export const defaultCancelTimer: typeof clearTimeout = (handle) => clearTimeout(handle)
