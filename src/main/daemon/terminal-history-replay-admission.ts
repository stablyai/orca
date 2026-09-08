import { PrioritySemaphore } from '../../shared/priority-semaphore'

// A full-depth scratch grid is temporary, but concurrent grids multiply peak memory.
export const terminalHistoryReplayAdmission = new PrioritySemaphore(1)
