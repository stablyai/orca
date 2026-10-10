import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { it, expect } from 'vitest'
import { createClaudeUserMessageQueue } from './claude-agent-sdk-user-message-queue'
import { record, text } from './claude-structured-model-catalog'
import { query, type ModelInfo, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

class MemoryChild extends EventEmitter implements SpawnedProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  exitCode: number | null = null
  requests: string[] = []
  pending = ''
  constructor(private readonly models: () => ModelInfo[]) {
    super()
    this.stdin.on('data', (chunk) => {
      this.pending += chunk.toString()
      let end = this.pending.indexOf('\n')
      while (end >= 0) {
        const line = this.pending.slice(0, end)
        this.pending = this.pending.slice(end + 1)
        if (line.trim()) {
          const parsed: unknown = JSON.parse(line)
          const frame = record(parsed)
          const subtype = text(record(frame?.request)?.subtype)
          if (frame?.type === 'control_request' && subtype) {
            this.requests.push(subtype)
            this.stdout.write(
              `${JSON.stringify({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: frame.request_id,
                  response: {
                    models: this.models(),
                    commands: [],
                    agents: [],
                    output_style: 'default',
                    account: {}
                  }
                }
              })}\n`
            )
          }
        }
        end = this.pending.indexOf('\n')
      }
    })
    this.stdin.on('finish', () => this.kill('SIGTERM'))
  }
  kill(signal: NodeJS.Signals): boolean {
    if (!this.killed) {
      this.killed = true
      this.exitCode = 0
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', 0, signal)
    }
    return true
  }
}

it('real SDK keeps initialize models until a new query, not a repeated supportedModels read', async () => {
  let available: ModelInfo[] = []
  const children: MemoryChild[] = []
  const queues: ReturnType<typeof createClaudeUserMessageQueue>[] = []
  const makeQuery = () => {
    const queue = createClaudeUserMessageQueue()
    queues.push(queue)
    return query({
      prompt: queue.messages,
      options: {
        cwd: process.cwd(),
        pathToClaudeCodeExecutable: 'memory-only-claude',
        settingSources: [],
        env: { CLAUDE_CONFIG_DIR: process.cwd(), HOME: process.cwd() },
        spawnClaudeCodeProcess: () => {
          const child = new MemoryChild(() => available)
          children.push(child)
          return child
        }
      }
    })
  }
  const first = makeQuery()
  let second: ReturnType<typeof query> | null = null
  try {
    await first.initializationResult()
    expect(await first.supportedModels()).toEqual([])
    available = [{ value: 'recovered', displayName: 'Recovered', description: 'test' }]
    expect(await first.supportedModels()).toEqual([])
    expect(children[0].requests).toEqual(['initialize'])
    second = makeQuery()
    await second.initializationResult()
    expect(await second.supportedModels()).toEqual(available)
    expect(children[1].requests).toEqual(['initialize'])
  } finally {
    first.close()
    second?.close()
    for (const queue of queues) {
      queue.end()
    }
  }
})
