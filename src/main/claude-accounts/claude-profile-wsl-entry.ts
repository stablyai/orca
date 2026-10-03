import { ClaudeWslProfileRequest, runClaudeWslProfileRequest } from './claude-profile-wsl-guest'

async function main(): Promise<void> {
  // Why buffers: decoding per chunk corrupts a UTF-8 character split across reads.
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > 16_384) {
      throw new Error('Claude profile request is too large')
    }
    chunks.push(bytes)
  }
  const request = ClaudeWslProfileRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(JSON.stringify(await runClaudeWslProfileRequest(request)))
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
