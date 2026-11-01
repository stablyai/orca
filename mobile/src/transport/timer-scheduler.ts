// Injected timers cannot supply the Node-only __promisify__ member required by typeof setTimeout.
export type ScheduleTimer = (handler: () => void, ms: number) => ReturnType<typeof setTimeout>

// Browser global timers require a global receiver or throw Illegal invocation.
export const defaultScheduleTimer: ScheduleTimer = (handler, ms) => setTimeout(handler, ms)
export const defaultCancelTimer: typeof clearTimeout = (handle) => clearTimeout(handle)
