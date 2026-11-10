// Private build only: progress lines on stderr for slow Orca Cloud calls (create, wake, sleep), so
// a wait is always visible. Text mode prints "- …" lines; json mode prints NDJSON phase events;
// stdout keeps only the result. No spinners: stderr is often not a TTY.
import { RuntimeClientError } from '../runtime/types'

export type CloudProgressMode = 'text' | 'json' | 'none'

/** Long waits get one reassurance line at this point. */
export const CLOUD_SLOW_NOTICE_MS = 10_000

export function readCloudProgressMode(
  flags: Map<string, string | boolean>,
  json: boolean
): CloudProgressMode {
  const value = flags.get('progress') ?? (json ? 'none' : 'text')
  if (value !== 'text' && value !== 'json' && value !== 'none') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--progress must be one of: text, json, none',
      {
        field: 'progress'
      }
    )
  }
  return value
}

export type CloudProgress = {
  phase: (name: string, text: string, extra?: Record<string, unknown>) => void
  /** Runs `work`; if it is still running after CLOUD_SLOW_NOTICE_MS, prints one `slow` line. */
  track: <T>(work: Promise<T>, slowText: (seconds: number) => string) => Promise<T>
  elapsedSeconds: () => string
}

export function cloudProgress(
  mode: CloudProgressMode,
  now: () => number = Date.now
): CloudProgress {
  const started = now()
  const phase: CloudProgress['phase'] = (name, text, extra = {}) => {
    if (mode === 'json') {
      process.stderr.write(
        `${JSON.stringify({ event: 'phase', phase: name, at: now(), elapsedMs: now() - started, ...extra })}\n`
      )
    } else if (mode === 'text') {
      console.error(`- ${text}`)
    }
  }
  return {
    phase,
    elapsedSeconds: () => ((now() - started) / 1000).toFixed(1),
    track: async (work, slowText) => {
      const timer = setTimeout(() => {
        phase('slow', slowText(Math.round((now() - started) / 1000)))
      }, CLOUD_SLOW_NOTICE_MS)
      timer.unref?.()
      try {
        return await work
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
