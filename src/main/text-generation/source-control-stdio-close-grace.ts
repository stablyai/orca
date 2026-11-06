import type { SpawnedSourceControlAgentProcess } from './source-control-text-generation-types'

// A grandchild holding inherited pipes must not keep a budgeted request or its home lock open forever.
const STDIO_CLOSE_GRACE_MS = 2_000

export function scheduleStdioCloseGrace(
  child: SpawnedSourceControlAgentProcess,
  close: () => void
): () => void {
  const timer = setTimeout(() => {
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
    try {
      // Release the supervised group-report channel a grandchild may also hold.
      if (child.connected) {
        child.disconnect()
      }
    } catch {}
    close()
  }, STDIO_CLOSE_GRACE_MS)
  return () => clearTimeout(timer)
}
