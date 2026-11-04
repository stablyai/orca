/** An idle timeout releases the native writer; it never times out an admitted command. */
export class ProfileStateWriterIdleStop {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly delay: number | undefined,
    private readonly stop: () => void
  ) {}

  get pending(): boolean {
    return this.timer !== undefined
  }

  schedule(): void {
    if (this.delay === undefined || this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.stop()
    }, this.delay)
    this.timer.unref?.()
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

export function closeIdleProfileStateWriter(
  writer: { assertWritable(): void; readonly acknowledgedRevision: number; close(): Promise<void> },
  onClosedRevision: (revision: number) => void,
  onSettled: () => void
): Promise<void> | undefined {
  let revision: number
  try {
    // A faulted writer stays in place so assertWritable keeps reporting its failure.
    writer.assertWritable()
    revision = writer.acknowledgedRevision
  } catch {
    return
  }
  return writer
    .close()
    .then(() => onClosedRevision(revision))
    .catch(() => {})
    .finally(onSettled)
}

export async function finishProfileStateWriterClose(
  backups: { stop(): void; drain(): Promise<void> },
  stopping: Promise<void> | undefined,
  currentWriter: () => { close(): Promise<void> } | null
): Promise<void> {
  backups.stop()
  // An in-flight idle stop owns the writer until it finishes.
  const writerClosed = stopping
    ? stopping.then(() => currentWriter()?.close())
    : currentWriter()?.close()
  const settled = await Promise.allSettled([backups.drain(), writerClosed])
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
}

export function requireStoppedProfileRevision(revision: number | undefined): number {
  if (revision === undefined) {
    throw new Error('Profile state writer stopped without an acknowledged revision')
  }
  return revision
}
