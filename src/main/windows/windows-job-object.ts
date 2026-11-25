import { windowsProcessTreeAddon } from './windows-process-table'

/** Kill-on-close job exports of the patched windows-process-tree addon. */
export type WindowsJobObjectApi = {
  createKillOnCloseJob: () => unknown
  assignProcessToJob: (job: unknown, pid: number) => boolean
  /** null when the process could not be opened. */
  isProcessInJob: (job: unknown, pid: number) => boolean | null
  /** Ends every member, then closes the job. */
  terminateJob: (job: unknown) => boolean
}

/** The job exports, or null off Windows or with an addon built before them. */
export function windowsJobObjectApi(): WindowsJobObjectApi | null {
  const addon = windowsProcessTreeAddon()
  if (
    typeof addon?.createKillOnCloseJob !== 'function' ||
    typeof addon.assignProcessToJob !== 'function' ||
    typeof addon.isProcessInJob !== 'function' ||
    typeof addon.terminateJob !== 'function'
  ) {
    return null
  }
  return {
    createKillOnCloseJob: addon.createKillOnCloseJob,
    assignProcessToJob: addon.assignProcessToJob,
    isProcessInJob: addon.isProcessInJob,
    terminateJob: addon.terminateJob
  }
}
