const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')

async function main() {
  const { consumeHostedChatPtyInput } = await import('./hosted-chat-transcript-fixture.mjs')
  const [transcriptPath, receiptPath] = process.argv.slice(2)
  const metadata = JSON.parse(readFileSync(transcriptPath, 'utf8').split('\n')[0])
  const port = Number(process.env.ORCA_AGENT_HOOK_PORT)
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  const paneKey = process.env.ORCA_PANE_KEY
  if (!port || !token || !paneKey || !metadata.payload?.id || !process.stdin.isTTY) {
    throw new Error('Owned chat PTY fixture has no hook authority or transcript')
  }
  for (const hook_event_name of ['SessionStart', 'Stop']) {
    const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey,
        payload: {
          hook_event_name,
          session_id: metadata.payload.id,
          transcript_path: transcriptPath
        }
      })
    })
    if (!response.ok) {
      throw new Error(`Owned chat hook refused: ${response.status}`)
    }
  }
  writeFileSync(receiptPath, '', { mode: 0o600 })
  process.stdout.write('ORCA_CHAT_PTY_READY\r\n')
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  let pending = ''
  process.stdin.on('data', (chunk) => {
    const input = consumeHostedChatPtyInput(pending, chunk)
    pending = input.pending
    for (const text of input.submitted) {
      appendFileSync(receiptPath, `${JSON.stringify({ text, submitted: true })}\n`)
    }
  })
  process.stdin.resume()
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
