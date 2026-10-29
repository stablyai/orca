import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'

export function remainingFilesystemHostBudget(expiresAt: number): number {
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) {
    throw new FilesystemHostSupervisorError('deadline', 'Filesystem host deadline expired')
  }
  return remaining
}

export async function withinFilesystemHostDeadline<T>(
  task: Promise<T>,
  expiresAt: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new FilesystemHostSupervisorError('deadline', 'Filesystem host deadline expired')
            ),
          Math.max(0, expiresAt - Date.now())
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
