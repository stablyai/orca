import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { extractAllOscTitles } from '../../shared/agent-detection'

const captureEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('title'), title: z.string(), atMs: z.number() }),
  z.object({ kind: z.literal('input'), text: z.string(), label: z.string(), atMs: z.number() })
])

export function loadClaudeInterruptCapture(name: string) {
  const base = join(__dirname, '../runtime/__fixtures__', `claude-interrupt-${name}`)
  const transcript = readFileSync(`${base}.txt`, 'utf8')
  const events = z.array(captureEvent).parse(JSON.parse(readFileSync(`${base}.input.json`, 'utf8')))
  const titles = extractAllOscTitles(transcript)
  const recordedTitles = events.flatMap((event) => (event.kind === 'title' ? [event.title] : []))
  if (JSON.stringify(titles) !== JSON.stringify(recordedTitles)) {
    throw new Error('Capture timeline must match the raw PTY title frames in byte order')
  }
  let offset = 0
  return events.map((event) => {
    if (event.kind === 'input') {
      return event
    }
    const candidates = ['0', '2'].flatMap((opcode) =>
      ['\x07', '\x1b\\'].map((end) => `\x1b]${opcode};${event.title}${end}`)
    )
    const frame = candidates.find((candidate) => transcript.includes(candidate, offset))
    if (!frame) {
      throw new Error('Captured OSC title frame missing from transcript')
    }
    const end = transcript.indexOf(frame, offset) + frame.length
    const chunk = transcript.slice(offset, end)
    offset = end
    return { ...event, chunk }
  })
}
