// One log line per finished wake with the time each phase was reached, so wake latency can be
// read off a real run (click → resume answered → usable) without a profiler attached.
import type { CloudWakeProgressEvent } from '../../shared/hosted-sandbox/cloud-workspace-api'

type Phase = CloudWakeProgressEvent['phase']
const open = new Map<string, { startedAt: number; marks: Partial<Record<Phase, number>> }>()

export function noteWakeTimeline(
  event: Pick<CloudWakeProgressEvent, 'workspaceId' | 'phase' | 'source' | 'startedAt'>,
  now: number,
  log: (line: string) => void = (line) => console.log(line)
): void {
  let entry = open.get(event.workspaceId)
  if (!entry || entry.startedAt !== event.startedAt) {
    entry = { startedAt: event.startedAt, marks: {} }
    open.set(event.workspaceId, entry)
  }
  entry.marks[event.phase] ??= now - event.startedAt
  if (event.phase === 'ready' || event.phase === 'failed') {
    open.delete(event.workspaceId)
    log(JSON.stringify({ event: 'cloud_wake_timeline', source: event.source, ms: entry.marks }))
  }
}
