// macOS 26+ AppKit can re-enter FrontBoardServices' scene queue from its own callout and wait on itself forever.
const SELF_DEADLOCK_FRAMES = [
  '-[FBSScene _sendUpdate:]',
  '-[BSServiceDispatchQueue performAsyncAndWait:]',
  '__DISPATCH_WAIT_FOR_QUEUE__'
]

const THREAD_ROOT_PATTERN = /^\s*(\d+) Thread_\S+/
const CALL_GRAPH_LINE_PATTERN = /^[\s+!:|]*(\d+) (.*)$/

// Parses `/usr/bin/sample` output: true only when every main-thread sample is parked in the scene self-wait.
export function isAppKitSceneSelfDeadlockSample(sampleReport: string): boolean {
  const lines = sampleReport.split('\n')
  const mainIndex = lines.findIndex(
    (line) => THREAD_ROOT_PATTERN.test(line) && line.includes('com.apple.main-thread')
  )
  if (mainIndex === -1) {
    return false
  }
  const total = Number(THREAD_ROOT_PATTERN.exec(lines[mainIndex])?.[1])
  if (!Number.isInteger(total) || total <= 0) {
    return false
  }
  const pending = new Set(SELF_DEADLOCK_FRAMES)
  for (let index = mainIndex + 1; index < lines.length && pending.size > 0; index++) {
    const line = lines[index]
    if (THREAD_ROOT_PATTERN.test(line) || line.trim() === '') {
      break
    }
    const match = CALL_GRAPH_LINE_PATTERN.exec(line)
    if (!match || Number(match[1]) !== total) {
      continue
    }
    for (const frame of pending) {
      if (match[2].startsWith(frame)) {
        pending.delete(frame)
      }
    }
  }
  return pending.size === 0
}
