// The injected-timer seam's real contract: `typeof setTimeout` additionally demands
// Node's `__promisify__` member, which no injected timer (or safe wrapper) can supply.
export type ScheduleTimer = (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
