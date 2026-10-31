import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import { expect, it, vi } from 'vitest'
import { openClaudeStreamJsonConnection } from './claude-stream-json-connection'

it.skipIf(process.platform === 'win32')(
  'initializes before a delayed success report, then ACKs it and completes normally',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-late-launch-'))
    const scenario = join(root, 'scenario.json')
    const release = join(root, 'provider-release')
    await writeFile(
      scenario,
      JSON.stringify({
        steps: [
          { awaitControlRequest: 'initialize' },
          { awaitFile: { path: release, timeoutMs: 10_000 } },
          { exit: 0 }
        ]
      })
    )
    const held: unknown[][] = []
    let deliver: (() => void) | undefined
    let closed: Promise<void> | undefined
    let stream: Duplex | undefined
    let exitCode: number | null = null
    const connection = await openClaudeStreamJsonConnection(
      {
        pathToClaudeCodeExecutable: resolve(
          'src/main/claude/__fixtures__/claude-agent-sdk-scripted-cli.mjs'
        ),
        cwd: root,
        options: {},
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          CLAUDE_CONFIG_DIR: root,
          ORCA_SDK_CONTRACT_SCENARIO_PATH: scenario
        }
      },
      {},
      (spec) => {
        const child = spawnProcess(spec)
        const report = child.stdio[3]
        if (!(report instanceof Duplex)) {
          throw new Error('expected owned report pipe')
        }
        stream = report
        const emit = report.emit.bind(report)
        const interception = vi.spyOn(report, 'emit').mockImplementation((event, ...args) => {
          if (event === 'data') {
            held.push(args)
            return true
          }
          return emit(event, ...args)
        })
        deliver = () => {
          interception.mockRestore()
          for (const args of held.splice(0)) {
            emit('data', ...args)
          }
        }
        closed = new Promise((done) =>
          child.once('close', (code) => {
            exitCode = code
            done()
          })
        )
        return child
      },
      (params) =>
        query({ ...params, options: { ...params.options, processReceiveLifecycle: undefined } })
    )
    try {
      await connection.initializationResult()
      expect(connection.startupFailure).toBeUndefined()
      await vi.waitFor(() => expect(held.length).toBeGreaterThan(0))
      expect(stream?.destroyed).toBe(false)
      deliver?.()
      await vi.waitFor(() => expect(stream?.closed).toBe(true))
      await writeFile(release, '')
      await closed
      expect(exitCode).toBe(0)
      expect(connection.startupFailure).toBeUndefined()
    } finally {
      deliver?.()
      await writeFile(release, '')
      await connection.close()
      await closed
      vi.restoreAllMocks()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000
)

it.skipIf(process.platform === 'win32')(
  'keeps natural missing-command guidance in the default SDK operation',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-default-missing-'))
    const connection = await openClaudeStreamJsonConnection(
      {
        pathToClaudeCodeExecutable: join(root, 'missing-agent'),
        cwd: root,
        options: {},
        env: { PATH: process.env.PATH ?? '', HOME: root, CLAUDE_CONFIG_DIR: root }
      },
      {},
      undefined,
      (params) =>
        query({ ...params, options: { ...params.options, processReceiveLifecycle: undefined } })
    )
    try {
      const error = await connection.initializationResult().catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      expect(connection.startupFailure?.error).toBe(error)
      expect(connection.startupFailure?.failure.kind).toBe('cliMissing')
    } finally {
      await connection.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
