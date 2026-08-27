const remoteWorkspacePatchTailByTargetId = new Map<string, Promise<void>>()

export async function queueRemoteWorkspacePatch<T>(
  targetId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = remoteWorkspacePatchTailByTargetId.get(targetId) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => {}).then(() => tail)
  remoteWorkspacePatchTailByTargetId.set(targetId, queued)

  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (remoteWorkspacePatchTailByTargetId.get(targetId) === queued) {
      remoteWorkspacePatchTailByTargetId.delete(targetId)
    }
  }
}

export function clearRemoteWorkspacePatchTails(): void {
  remoteWorkspacePatchTailByTargetId.clear()
}

export function getRemoteWorkspacePatchTailCount(): number {
  return remoteWorkspacePatchTailByTargetId.size
}
