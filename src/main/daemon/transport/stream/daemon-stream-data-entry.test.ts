import { describe, expect, it } from 'vitest'
import { createPendingStreamDataBatch } from './daemon-stream-data-batch'
import { appendDaemonStreamData, flushDaemonStreamSession } from './daemon-stream-data-entry'
import { accountDaemonStreamEntry } from './daemon-stream-entry-accounting'
import { streamFramesFor } from '../framing/daemon-stream-data-split'

describe('flushDaemonStreamSession', () => {
  it('marks control frames as carrying no session output, so they earn no delivery credit', () => {
    const batch = createPendingStreamDataBatch()
    appendDaemonStreamData(batch, 'tui', 'hello', {})
    batch.queue.push(
      accountDaemonStreamEntry(batch, {
        sessionId: 'tui',
        data: '',
        control: {
          type: 'event',
          event: 'sessionBackgroundMarker',
          sessionId: 'tui',
          payload: { background: true }
        }
      })
    )
    const writes: { line: string; carries: boolean | undefined }[] = []
    flushDaemonStreamSession(batch, 'tui', 1 << 20, streamFramesFor(), (line, carries) =>
      writes.push({ line: String(line), carries })
    )
    expect(writes.map((write) => write.carries !== false)).toEqual([true, false])
    expect(writes[1].line).toContain('sessionBackgroundMarker')
  })
})
