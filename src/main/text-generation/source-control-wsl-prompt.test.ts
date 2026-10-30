import { spawnProcess } from '@orca/process-host'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import { prepareWslPrompt } from './source-control-prompt-files'
import { producePromptRecords } from './source-control-prompt-producer'
import { runLocalSourceControlPlan } from './source-control-local-process'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import {
  withPlatform,
  createMockDiscoveryChild
} from './commit-message-text-generation-test-harness'
import type { SourceControlAgentSpawnInput } from './source-control-text-generation-types'
import type * as Removal from '../../shared/windows-transient-lock-removal'

const { removeTreeMock } = vi.hoisted(() => ({ removeTreeMock: vi.fn(async () => {}) }))
vi.mock('../../shared/windows-transient-lock-removal', async (original) => ({
  ...(await original<typeof Removal>()),
  removeTree: removeTreeMock
}))
vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: vi.fn(async () => true)
}))
vi.mock('../wsl-background-distro-gate', () => ({ noteWslDistroLaunched: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  removeTreeMock.mockReset()
  removeTreeMock.mockResolvedValue(undefined)
})

const cwd = '\\\\wsl.localhost\\Actual\\home\\dev\\repo'
function plan(content = 'sensitive request') {
  const planned = planCommitMessageGeneration({ agentId: 'omp', model: 'default' }, content)
  if (!planned.ok) {
    throw new Error(planned.error)
  }
  return planned.plan
}
function start(child = createMockDiscoveryChild(), content?: string) {
  let launch: SourceControlAgentSpawnInput | undefined
  const execution = withPlatform('win32', () =>
    runLocalSourceControlPlan({
      plan: plan(content),
      cwd,
      wslDistro: 'Wrong',
      env: undefined,
      operation: 'conversation-name',
      spawnAgent: (input) => {
        launch = input
        return child
      }
    })
  )
  const nonce = launch?.preparation?.args[0]
  if (!nonce) {
    throw new Error('Expected preparation')
  }
  return { child, launch, nonce, execution, proof: `ORCA_GENERATION_READY:${nonce}\n` }
}
function close(child: ReturnType<typeof createMockDiscoveryChild>, code = 0) {
  child.stdout.emit('data', Buffer.from('Lighthouse Signal Trace'))
  child.emit('exit', code)
  child.emit('close', code)
}

it('waits for fragmented exact proof, streams once and cleans only the actual guest after terminal', async () => {
  const { child, launch, nonce, execution, proof } = start()
  const writes: string[] = []
  child.stdin.on('data', (chunk) => writes.push(chunk.toString()))
  expect(launch?.wslDistro).toBe('Actual')
  expect(launch?.args).toContain(`@/tmp/orca-generation-${nonce}/prompt-1.txt`)
  expect(child.stdin.end).not.toHaveBeenCalled()
  child.stderr.emit('data', Buffer.from(`${proof.trim()}WRONG\n${'x'.repeat(100_000)}\n`))
  child.stderr.emit('data', Buffer.from(proof.slice(0, 17)))
  expect(writes).toEqual([])
  child.stderr.emit('data', Buffer.from(proof.slice(17)))
  child.stderr.emit('data', Buffer.from(proof))
  expect(writes.join('')).toBe(`A${nonce}\nD﻿sensitive request\nF${nonce}:1\nX${nonce}\n`)
  expect(removeTreeMock).not.toHaveBeenCalled()
  close(child)
  expect(await execution.result).toMatchObject({ success: true })
  await execution.processClosed
  expect(removeTreeMock).toHaveBeenCalledExactlyOnceWith(
    `\\\\wsl.localhost\\Actual\\tmp\\orca-generation-${nonce}`
  )
  child.stderr.emit('data', Buffer.from(proof))
  expect(removeTreeMock).toHaveBeenCalledTimes(1)
})

it.each(['cancel', 'deadline', 'exit', 'overflow', 'stdin-error', 'stdin-close'] as const)(
  'stops pending input on %s, and late proof only cleans without reopening result',
  async (route) => {
    vi.useFakeTimers()
    const { child, execution, proof } = start()
    const writes = vi.spyOn(child.stdin, 'write')
    if (route === 'cancel') {
      cancelLocalGeneration('conversation-name', cwd)
    }
    if (route === 'deadline') {
      await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    }
    if (route === 'exit') {
      close(child)
    }
    if (route === 'overflow') {
      child.stdout.emit('data', Buffer.alloc(MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES + 1))
    }
    if (route === 'stdin-error') {
      child.stdin.emit('error', new Error('EPIPE'))
    }
    if (route === 'stdin-close') {
      child.stdin.emit('close')
    }
    child.stderr.emit('data', Buffer.from(proof))
    expect(writes).not.toHaveBeenCalled()
    close(child)
    await execution.result
    await execution.processClosed
    expect(removeTreeMock).toHaveBeenCalledTimes(1)
    child.stdin.emit('error', new Error('late EPIPE'))
  }
)

it.each(['cancel', 'deadline', 'exit', 'error', 'close', 'overflow'] as const)(
  'releases a never-draining producer on %s without final authorization',
  async (route) => {
    vi.useFakeTimers()
    const { child, execution, proof, nonce } = start(undefined, 'x'.repeat(50_000))
    const write = vi.spyOn(child.stdin, 'write').mockReturnValue(false)
    child.stderr.emit('data', Buffer.from(proof))
    expect(write).toHaveBeenCalledExactlyOnceWith(`A${nonce}\n`)
    if (route === 'cancel') {
      cancelLocalGeneration('conversation-name', cwd)
    }
    if (route === 'deadline') {
      await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    }
    if (route === 'exit') {
      child.emit('exit', 1)
    }
    if (route === 'error') {
      child.stdin.emit('error', new Error('EPIPE'))
    }
    if (route === 'close') {
      child.stdin.emit('close')
    }
    if (route === 'overflow') {
      child.stderr.emit('data', Buffer.alloc(MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES + 1))
    }
    await Promise.resolve()
    child.stdin.emit('drain')
    close(child, 1)
    await execution.result
    await execution.processClosed
    expect(write).toHaveBeenCalledTimes(1)
    expect(child.stdin.listenerCount('drain')).toBe(0)
    expect(removeTreeMock).toHaveBeenCalledTimes(1)
  }
)

it.each(['missing-proof', 'spawn', 'no-pid', 'missing-stdin'] as const)(
  'settles %s without invented ownership',
  async (route) => {
    vi.useFakeTimers()
    const child = createMockDiscoveryChild()
    if (route === 'missing-stdin') {
      Object.defineProperty(child, 'stdin', { value: null })
    }
    if (route === 'no-pid') {
      Object.defineProperty(child, 'pid', { value: undefined })
    }
    const execution = withPlatform('win32', () =>
      runLocalSourceControlPlan({
        plan: plan(),
        cwd,
        env: undefined,
        operation: 'conversation-name',
        spawnAgent: () => {
          if (route === 'spawn') {
            throw new Error('spawn denied')
          }
          return child
        }
      })
    )
    if (route === 'no-pid') {
      child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }))
    }
    if (route === 'missing-proof') {
      await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    }
    if (route !== 'spawn' && route !== 'no-pid') {
      close(child, 1)
    }
    expect(await execution.result).toMatchObject({ success: false })
    await execution.processClosed
    expect(removeTreeMock).not.toHaveBeenCalled()
  }
)

it.each(['pending', 'rejected'] as const)(
  'never gates either promise on %s cleanup, even proof after processClosed',
  async (outcome) => {
    removeTreeMock.mockImplementation(() =>
      outcome === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('share unavailable'))
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { child, execution, proof } = start()
      close(child)
      expect(await execution.result).toMatchObject({ success: true })
      await execution.processClosed
      child.stderr.emit('data', Buffer.from(proof))
      child.stderr.emit('data', Buffer.from(proof))
      expect(removeTreeMock).toHaveBeenCalledTimes(1)
      expect(child.stdin.end).not.toHaveBeenCalled()
      await Promise.resolve()
    } finally {
      log.mockRestore()
    }
  }
)

const tricky = `${Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join('')}\\c\\012\r\n'!%$\`🌊界﻿\ud800`

async function shellFixture(
  content: string,
  controls?: (records: string[], nonce: string) => string[],
  setup?: (directory: string) => void,
  onProof?: (directory: string) => void
) {
  const guest = prepareWslPrompt(plan(content), 'Actual')
  const [nonce] = guest.preparation.args
  const directory = `/tmp/orca-generation-${nonce}`
  setup?.(directory)
  const child = spawnProcess({
    program: '/bin/sh',
    args: [
      '-c',
      guest.preparation.script,
      'fixture',
      ...guest.preparation.args,
      process.execPath,
      '-e',
      String.raw`
const fs = require('node:fs');
const paths = process.argv.slice(1).map(arg => arg.slice(1));
const files = paths.map(path => fs.readFileSync(path));
process.stdout.write(JSON.stringify({ content: Buffer.concat(files.map(file => Buffer.from(new TextDecoder().decode(file)))).toString('base64'),
 sizes: files.map(file => file.length), modes: paths.map(path => fs.statSync(path).mode & 511), directory: fs.statSync(process.env.FIXTURE_DIRECTORY).mode & 511,
 eof: require('node:fs').readFileSync(0).length }));
`,
      '--',
      ...guest.plan.args.filter((arg) => arg.startsWith('@'))
    ],
    stdio: 'pipe',
    env: { ...process.env, FIXTURE_DIRECTORY: directory }
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (bytes) => {
    stdout += bytes
  })
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve)
    child.once('error', reject)
  })
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    if (guest.observe(chunk)) {
      onProof?.(directory)
      const records = [...guest.records()]
      child.stdin.end((controls ? controls(records, nonce) : records).join(''))
    }
  })
  try {
    const code = await finished
    return {
      code,
      stdout,
      stderr,
      directory,
      existed: existsSync(directory),
      sentinel: existsSync(join(directory, 'sentinel'))
        ? readFileSync(join(directory, 'sentinel'), 'utf8')
        : null
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it.each(['', tricky.repeat(12), `${'x'.repeat(5 * 1024 * 1024 - 4)}🌊﻿GIF89a${tricky}`])(
  'materializes exact native text with private modes across encoding and file boundaries',
  async (content) => {
    const result = await shellFixture(content)
    expect(result.code).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(Buffer.from(receipt.content, 'base64').toString()).toBe(Buffer.from(content).toString())
    expect(receipt.modes.every((mode: number) => mode === 0o600)).toBe(true)
    expect(receipt.directory).toBe(0o700)
    expect(receipt.eof).toBe(0)
    expect(receipt.sizes.every((size: number) => size <= 5 * 1024 * 1024)).toBe(true)
    expect(result.existed).toBe(true)
  }
)

it.each([
  'collision',
  'partial-data',
  'wrong-end',
  'missing-end',
  'partial-execute',
  'extra-data',
  'wrong-ack'
] as const)('does not execute on %s, and never adopts/deletes a collision', async (route) => {
  const result = await shellFixture(
    'private data',
    (records, nonce) => {
      if (route === 'partial-data') {
        return [`A${nonce}\nDpartial`]
      }
      if (route === 'wrong-end') {
        return records.map((record) => (record.startsWith('F') ? `F${nonce}:2\n` : record))
      }
      if (route === 'missing-end') {
        return records.filter((record) => !record.startsWith('F'))
      }
      if (route === 'partial-execute') {
        return records.map((record) => (record.startsWith('X') ? record.trim() : record))
      }
      if (route === 'extra-data') {
        return [...records.slice(0, -1), 'Dextra\n', ...records.slice(-1)]
      }
      if (route === 'wrong-ack') {
        return ['Ano\n']
      }
      return records
    },
    (directory) => {
      if (route === 'collision') {
        mkdirSync(directory)
        writeFileSync(join(directory, 'sentinel'), 'untouched')
      }
    }
  )
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  if (route === 'collision') {
    expect(result.stderr).not.toContain('ORCA_GENERATION_READY:')
    expect(result.sentinel).toBe('untouched')
  }
  if (route === 'wrong-ack') {
    expect(result.existed).toBe(false)
  }
})

it.each([false, true])(
  'bounds real producer work at N and 10N (backpressure=%s)',
  async (backpressure) => {
    const results: number[] = []
    for (const size of [20_000, 200_000]) {
      const guest = prepareWslPrompt(
        plan(tricky.repeat(Math.ceil(size / tricky.length)).slice(0, size)),
        'Actual'
      )
      let writes = 0
      let maxRecord = 0
      let pending = 0
      let maxPending = 0
      let maxQueued = 0
      const stream = new Writable({
        highWaterMark: 2048,
        write(chunk, _encoding, callback) {
          writes++
          maxRecord = Math.max(maxRecord, chunk.length)
          maxPending = Math.max(maxPending, ++pending)
          const complete = () => {
            maxQueued = Math.max(maxQueued, stream.writableLength)
            pending--
            callback()
          }
          if (backpressure) {
            setImmediate(complete)
          } else {
            complete()
          }
        }
      })
      let yieldedAt = 0
      setImmediate(() => {
        yieldedAt = writes
      })
      const finished = new Promise<void>((resolve) => stream.once('finish', resolve))
      await producePromptRecords(stream, guest.records(), new AbortController().signal, () => true)
      await finished
      expect(maxQueued).toBeLessThanOrEqual(2048 + 1026)
      expect(yieldedAt).toBeGreaterThan(0)
      expect(yieldedAt).toBeLessThan(writes)
      expect(maxRecord).toBeLessThanOrEqual(1026)
      expect(maxPending).toBe(1)
      results.push(writes)
    }
    expect(results[1]).toBeLessThanOrEqual(results[0] * 10 + 10)
    expect(results[1]).toBeGreaterThan(results[0] * 8)
  }
)

it('fails a real post-proof storage redirect without running a partial request', async () => {
  const result = await shellFixture('private data', undefined, undefined, (directory) =>
    mkdirSync(join(directory, 'prompt-1.txt'))
  )
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.existed).toBe(true)
})

it.each([
  { boundary: 'data', stopping: 'cancel' },
  { boundary: 'final', stopping: 'cancel' },
  { boundary: 'data', stopping: 'deadline' },
  { boundary: 'final', stopping: 'deadline' }
] as const)(
  'does not authorize after $stopping at $boundary write continuation',
  async ({ boundary, stopping }) => {
    vi.useFakeTimers()
    const { child, execution, proof, nonce } = start()
    const writes: string[] = []
    vi.spyOn(child.stdin, 'write').mockImplementation((chunk) => {
      const record = String(chunk)
      writes.push(record)
      if (record.startsWith(boundary === 'data' ? 'D' : 'F')) {
        if (stopping === 'cancel') {
          cancelLocalGeneration('conversation-name', cwd)
        } else {
          vi.advanceTimersByTime(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
        }
      }
      return true
    })
    child.stderr.emit('data', Buffer.from(proof))
    close(child)
    expect(await execution.result).toMatchObject(
      stopping === 'cancel'
        ? { success: false, canceled: true }
        : { success: false, error: 'Generation timed out after 60s.' }
    )
    await execution.processClosed
    expect(writes).not.toContain(`X${nonce}\n`)
  }
)

it.each(['success', 'nonzero', 'empty', 'storage', 'pipe-close'] as const)(
  'runs the production attempt through real private shell preparation and %s',
  async (outcome) => {
    let directory = ''
    let actualPipeError = false
    const execution = withPlatform('win32', () =>
      runLocalSourceControlPlan({
        plan: plan(tricky.repeat(40)),
        cwd,
        env: undefined,
        operation: 'conversation-name',
        spawnAgent: (input) => {
          const preparation = input.preparation
          if (!preparation) {
            throw new Error('Missing preparation')
          }
          directory = `/tmp/orca-generation-${preparation.args[0]}`
          const argv =
            outcome === 'pipe-close'
              ? [
                  '-c',
                  `exec 0<&-; printf 'ORCA_GENERATION_READY:%s\\n' "$1" >&2; sleep 0.1`,
                  'fixture',
                  preparation.args[0]
                ]
              : [
                  '-c',
                  preparation.script,
                  'fixture',
                  ...preparation.args,
                  '/bin/sh',
                  '-c',
                  outcome === 'empty'
                    ? ':'
                    : `printf '%s' 'Useful name'; exit ${outcome === 'nonzero' ? 7 : 0}`
                ]
          const child = withPlatform('darwin', () =>
            spawnProcess({ program: '/bin/sh', args: argv, stdio: 'pipe' })
          )
          child.stdin.on('error', (error) => {
            actualPipeError ||= 'code' in error && error.code === 'EPIPE'
          })
          if (outcome === 'storage') {
            child.stderr.once('data', () => mkdirSync(join(directory, 'prompt-1.txt')))
          }
          return child
        }
      })
    )
    try {
      const result = await execution.result
      await execution.processClosed
      expect(result.success).toBe(outcome === 'success')
      expect(removeTreeMock).toHaveBeenCalledTimes(1)
      if (outcome === 'pipe-close') {
        expect(actualPipeError).toBe(true)
      }
      if (outcome === 'success') {
        const file = readFileSync(join(directory, 'prompt-1.txt'))
        expect(new TextDecoder().decode(file)).toBe(Buffer.from(tricky.repeat(40)).toString())
      }
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
)
