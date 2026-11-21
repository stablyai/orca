import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCodexCommand } from '../../../codex-cli/command'
import { openCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import { codexStructuredPermissionPolicy } from '../../../../shared/agent-launch/permissions/codex-permission-policy'
import { openCodexThread } from '../threads/codex-structured-thread-open'

const enabled = process.env.ORCA_REAL_CODEX_CLI_TEST === '1'

/** A stand-in model provider that records each request body and fails it, ending the turn. */
async function recordingProvider(): Promise<{ server: Server; port: number; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    request.on('end', () => {
      bodies.push(body)
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'recorded', type: 'invalid_request_error' } })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the recording provider has no port')
  }
  return { server, port: address.port, bodies }
}

/** Opens the thread and sends one message, so the provider sees what the model would. */
async function askWith(
  base: string,
  resumeThreadId: string | null,
  developerInstructions: string
): Promise<string> {
  const cwd = join(base, 'workspace')
  let turnCompleted: () => void = () => {}
  const turnEnded = new Promise<void>((resolve) => (turnCompleted = resolve))
  const connection = await openCodexAppServerConnection(
    {
      command: resolveCodexCommand(),
      args: ['app-server'],
      cwd,
      env: { HOME: base, CODEX_HOME: join(base, 'codex-home'), OPENAI_API_KEY: 'test' }
    },
    {
      onNotification: (method) => {
        if (method === 'turn/completed') {
          turnCompleted()
        }
      }
    }
  )
  try {
    const opened = await openCodexThread(
      connection,
      {
        cwd,
        resumeThreadId,
        permissionPolicy: codexStructuredPermissionPolicy('ask'),
        developerInstructions
      },
      20_000
    )
    await connection.request(
      'turn/start',
      { threadId: opened.threadId, input: [{ type: 'text', text: 'hello' }] },
      { timeoutMs: 10_000 }
    )
    await turnEnded
    return opened.threadId
  } finally {
    await connection.close()
  }
}

describe.skipIf(!enabled)('Codex real app-server developer instructions', () => {
  it(
    'sends the instructions to the model, and a resumed thread keeps them',
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'orca-real-codex-instructions-'))
      const provider = await recordingProvider()
      try {
        mkdirSync(join(base, 'workspace'), { recursive: true })
        mkdirSync(join(base, 'codex-home'), { recursive: true })
        writeFileSync(
          join(base, 'codex-home', 'config.toml'),
          [
            'model_provider = "recording"',
            'model = "gpt-5"',
            '[model_providers.recording]',
            'name = "recording"',
            `base_url = "http://127.0.0.1:${provider.port}/v1"`,
            'env_key = "OPENAI_API_KEY"',
            'wire_api = "responses"',
            'request_max_retries = 0',
            'stream_max_retries = 0',
            ''
          ].join('\n')
        )
        const threadId = await askWith(base, null, 'You are FIRST-SOUL-7f3a.')
        expect(provider.bodies.join('\n')).toContain('FIRST-SOUL-7f3a')

        provider.bodies.length = 0
        expect(await askWith(base, threadId, 'You are SECOND-SOUL-91c2.')).toBe(threadId)
        expect(provider.bodies.join('\n')).toContain('FIRST-SOUL-7f3a')
      } finally {
        provider.server.close()
        rmSync(base, { recursive: true, force: true })
      }
    },
    // Two cold app-server starts, each with a model request.
    120_000
  )
})
