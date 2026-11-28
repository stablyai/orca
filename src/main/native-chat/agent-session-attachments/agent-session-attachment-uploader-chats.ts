// Uploads whose chat is remembered until a message claims them; the oldest go first past this.
const UPLOADED_FOR_KEPT = 256

/** The chat each upload this launch was made for, newest kept. */
export class AttachmentUploaderChats {
  private readonly byUpload = new Map<string, string>()

  remember(uploadId: string, sessionId: string): void {
    this.byUpload.set(uploadId, sessionId)
    for (const oldest of this.byUpload.keys()) {
      if (this.byUpload.size <= UPLOADED_FOR_KEPT) {
        break
      }
      this.byUpload.delete(oldest)
    }
  }

  chatOf(uploadId: string): string | undefined {
    return this.byUpload.get(uploadId)
  }
}
