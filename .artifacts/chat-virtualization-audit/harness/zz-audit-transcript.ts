import { writeFileSync, appendFileSync } from 'node:fs'
type Kind = 'text' | 'tools' | 'control'
const TOOL_OUTPUT_BYTES = Number(process.env.AUDIT_TOOL_BYTES ?? 20000)
export function marker(index: number): string {
  return `AUDIT row ${String(index).padStart(6, '0')}`
}

export function writeTranscript(file: string, kind: Kind, count: number, sessionId: string): void {
  writeFileSync(file, '')
  const startedAt = Date.now() - count * 1_000
  let buffer: string[] = []
  const flush = (): void => {
    appendFileSync(file, buffer.join(''))
    buffer = []
  }
  const filler = 'x'.repeat(78)
  const bigOutput = Array.from(
    { length: Math.ceil(TOOL_OUTPUT_BYTES / 80) },
    (_, line) => `${String(line).padStart(5, '0')} ${filler}`
  ).join('\n')
  for (let index = 0; index < count; index += 1) {
    const ts = new Date(startedAt + index * 1_000).toISOString()
    const isUser = index % 2 === 0
    const body = Array.from(
      { length: 1 + (index % 7) },
      (_u, line) =>
        `Paragraph ${line + 1} of ${marker(index)}: ${'lorem ipsum dolor sit amet '.repeat(1 + ((index * 7 + line) % 9))}`
    ).join('\n\n')
    let content: unknown[] = [{ type: 'text', text: `${marker(index)}\n\n${body}` }]
    if (kind === 'tools' && !isUser) {
      const toolId = `toolu_${index}`
      content = [
        { type: 'text', text: `${marker(index)}\n\nRunning a command.\n\n\`\`\`ts\nconst a = ${index}\n\`\`\`` },
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `cat file-${index}.log` } }
      ]
      buffer.push(
        `${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}`,
          timestamp: ts,
          type: 'assistant',
          message: { role: 'assistant', model: 'claude-opus-4', content }
        })}\n`
      )
      buffer.push(
        `${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}-r`,
          timestamp: ts,
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolId, content: bigOutput }]
          }
        })}\n`
      )
    } else {
      buffer.push(
        `${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}`,
          timestamp: ts,
          type: isUser ? 'user' : 'assistant',
          message: { role: isUser ? 'user' : 'assistant', model: 'claude-opus-4', content }
        })}\n`
      )
    }
    if (buffer.length > 2_000) {
      flush()
    }
  }
  flush()
}

