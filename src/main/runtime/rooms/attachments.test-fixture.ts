export function unusedRoomAttachments() {
  const unexpected = (): never => {
    throw new Error('Unexpected attachment call in test')
  }
  return { consumeUploads: unexpected, remove: unexpected }
}
