import type { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

export class ProfileStateIdleWriterStop {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly options: {
      delay: () => number | undefined
      getWriter: () => ProfileStateWriteWorkerClient | null
      shouldSchedule: () => boolean
      stop: (writer: ProfileStateWriteWorkerClient) => void
    }
  ) {}

  scheduleAfterReady(): void {
    void this.options.getWriter()?.ready.then(
      () => this.schedule(),
      () => {}
    )
  }

  schedule(): void {
    const delay = this.options.delay()
    if (
      delay === undefined ||
      this.timer ||
      this.options.shouldSchedule() ||
      !this.options.getWriter()
    ) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      const writer = this.options.getWriter()
      if (writer) {
        this.options.stop(writer)
      }
    }, delay)
    this.timer.unref?.()
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

export function closeIdleProfileStateWriter(
  writer: ProfileStateWriteWorkerClient,
  canStop: () => boolean,
  onClosed: (revision: number) => void
): Promise<void> | undefined {
  if (!canStop()) {
    return undefined
  }
  let revision: number
  try {
    writer.assertWritable()
    revision = writer.acknowledgedRevision
  } catch {
    return undefined
  }
  return writer
    .close({ refreshLegacyDocuments: true })
    .then(() => onClosed(revision))
    .catch(() => {})
}
