import {
  emptyHangStacks,
  hangLabel,
  hangModule,
  topHangStacks,
  type HangFrame,
  type HangStack,
  type NativeHangCapture
} from './hang-stacks'

export function reduceNativeHangSample(
  text: string
): Pick<
  NativeHangCapture,
  | 'stacks'
  | 'samples'
  | 'validSamples'
  | 'truncated'
  | 'mainThreadIdentified'
  | 'mainSectionComplete'
> {
  let identified = false
  let complete = false
  let invalid = false
  let samples = 0
  let top: HangStack[] = []
  const path: { depth: number; frame: HangFrame; count: number }[] = []
  const acceptPath = (): void => {
    if (!path.length) {
      return
    }
    top = topHangStacks(
      [
        ...top,
        {
          count: path.at(-1)!.count,
          frames: path
            .slice(-8)
            .map((item) => item.frame)
            .toReversed(),
          hot: false
        }
      ],
      samples
    )
  }
  const lines = text.slice(0, 128 * 1024).split('\n')
  lines.pop() // A cut/unterminated line never establishes a frame or section boundary.
  for (const line of lines.slice(0, 4096)) {
    if (line.length > 1024) {
      if (identified) {
        invalid = true
        break
      }
      continue
    }
    const thread = /^\s{4}(\d+) Thread_\S+/.exec(line)
    if (!identified) {
      if (thread && /\b(?:DispatchQueue_\d+: )?com\.apple\.main-thread\b/.test(line)) {
        identified = true
        samples = Number(thread[1])
      }
      continue
    }
    if (thread || /^(?:Binary Images:|Total number in stack|Sort by top of stack)/.test(line)) {
      acceptPath()
      complete = !invalid
      break
    }
    const frame = /^([\s+|!:]*)(\d+) (.+?)\s+\(in ([^)]+)\)(?:\s+.*)?$/.exec(line)
    if (!frame) {
      if (line.trim()) {
        invalid = true
        break
      }
      continue
    }
    const depth = frame[1].length
    const count = Number(frame[2])
    if (!Number.isSafeInteger(count) || count <= 0 || count > samples) {
      invalid = true
      break
    }
    if (path.length && depth <= path.at(-1)!.depth) {
      acceptPath()
    }
    while (path.length && path.at(-1)!.depth >= depth) {
      path.pop()
    }
    if (path.length >= 256) {
      invalid = true
      break
    }
    path.push({
      depth,
      count,
      frame: {
        name: hangLabel(frame[3].replace(/\s+\+\s+\d+.*$/, '')),
        module: hangModule(frame[4])
      }
    })
  }
  if (!complete) {
    acceptPath()
  }
  return {
    stacks: top,
    samples,
    validSamples: samples,
    truncated: invalid || !complete,
    mainThreadIdentified: identified,
    mainSectionComplete: complete
  }
}

export function captureNativeHang(options: {
  pid: number
  publish: (capture: NativeHangCapture) => void
}): { stop: () => void; done: Promise<void> } {
  const abort = new AbortController()
  let terminated = false
  let release: () => void = () => {}
  const termination = new Promise<void>((resolve) => {
    release = resolve
  })
  const baseline: NativeHangCapture = {
    ...emptyHangStacks(),
    state: 'collecting',
    startedAt: Date.now(),
    mainThreadIdentified: false,
    mainSectionComplete: false,
    reportTruncated: false,
    timedOut: false,
    cleanup: 'pending'
  }
  options.publish(baseline)
  let latest = baseline
  const publish = (capture: NativeHangCapture): void => {
    latest = capture
    options.publish(capture)
  }
  const done = (async (): Promise<void> => {
    try {
      const { runProcess } = await import('@orca/process-host')
      const result = await runProcess({
        program: '/usr/bin/sample',
        args: [String(options.pid), '1', '10', '-file', '/dev/stdout'],
        timeoutMs: 2500,
        maxOutputBytes: 128 * 1024,
        killOnOutputLimit: true,
        signal: abort.signal,
        onChildTerminated: () => {
          terminated = true
          release()
        }
      })
      publish({
        ...baseline,
        ...reduceNativeHangSample(result.stdout),
        state: 'completed',
        completedAt: Date.now(),
        reportTruncated: result.outputTruncated === true,
        timedOut: result.timedOut,
        cleanup: terminated ? 'terminated' : 'unverified',
        ...(result.code !== null ? { exitCode: result.code } : {})
      })
    } catch {
      publish({
        ...baseline,
        state: 'failed',
        completedAt: Date.now(),
        cleanup: terminated ? 'terminated' : 'unverified'
      })
    }
    if (!terminated) {
      await termination
      publish({ ...latest, cleanup: 'terminated' })
    }
  })()
  return { stop: () => abort.abort(), done }
}
