import { RuntimeClientError } from './runtime-client'

// Why: argv is not a lossless channel on every host — the WSL bridge destroys embedded double
// quotes (#12231) — so payload-bearing flags need a route that never touches a command line.
export async function readStdinPayload(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin payload requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
