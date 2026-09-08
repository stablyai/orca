import { appendFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function appendHostedChatFeedMarker(transcriptPath) {
  const marker = `ORCA_CHAT_FEED_${randomUUID()}`
  await appendFile(
    transcriptPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: marker }] }
    })}\n`
  )
  return marker
}

export async function assertHostedChatInputReceipt(receiptPath, message) {
  const bytes = await readFile(receiptPath, 'utf8')
  const lines = bytes
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const matches = lines.filter((line) => line.text === message)
  if (matches.length !== 1 || matches[0].submitted !== true) {
    throw new Error('Chat input was not submitted exactly once to the fixture PTY')
  }
  return { submittedExactlyOnce: true }
}

export function consumeHostedChatPtyInput(pending, chunk) {
  const lines = (pending + String(chunk)).split(/[\r\n]/)
  const next = lines.pop()
  const submitted = lines
    .map((line) =>
      line
        .slice(line.lastIndexOf('\u0015') + 1)
        .replaceAll('\u001b[200~', '')
        .replaceAll('\u001b[201~', '')
    )
    .filter(Boolean)
  return { pending: next, submitted }
}
