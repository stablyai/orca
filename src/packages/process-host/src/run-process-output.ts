import { createOutputSink } from './bounded-output-sink'
import type { BufferedProcessChild, BufferedProcessSpawn, ProcessSpec } from './process-spec'
import { DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'

/** Collects a run's output and feeds its stderr observers; a full head capture stops a hosted child sending more. */
export function captureRunProcessOutput(
  spec: ProcessSpec,
  child: BufferedProcessChild,
  hosted: BufferedProcessSpawn | undefined,
  outputCapture: 'head' | 'tail',
  onOutputLimit: () => void
): {
  stdout: ReturnType<typeof createOutputSink>
  stderr: ReturnType<typeof createOutputSink>
} {
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const stdout = createOutputSink(maxOutputBytes, outputCapture)
  const stderr = createOutputSink(maxOutputBytes, outputCapture)
  // A full head capture keeps nothing more; a hosted child stops sending what no one reads.
  let stdoutDiscarded = false
  let stderrDiscarded = false
  const stderrObserved = Boolean(spec.onStderr) || typeof spec.terminationBarrier === 'object'
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout.write(chunk)
    if (spec.killOnOutputLimit && stdout.truncated()) {
      onOutputLimit()
    }
    if (
      outputCapture === 'head' &&
      !stdoutDiscarded &&
      stdout.truncated() &&
      hosted?.discardOutput
    ) {
      stdoutDiscarded = true
      hosted.discardOutput('stdout')
    }
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.write(chunk)
    if (
      outputCapture === 'head' &&
      !stderrObserved &&
      !stderrDiscarded &&
      stderr.truncated() &&
      hosted?.discardOutput
    ) {
      stderrDiscarded = true
      hosted.discardOutput('stderr')
    }
    spec.onStderr?.(chunk)
    if (spec.killOnOutputLimit && stderr.truncated()) {
      onOutputLimit()
    }
    if (typeof spec.terminationBarrier === 'object') {
      spec.terminationBarrier.observeStderr?.(chunk)
    }
  })
  return { stdout, stderr }
}
