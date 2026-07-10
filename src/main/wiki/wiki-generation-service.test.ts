import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/types'

const killProcessTree = vi.fn((child: { kill: (signal: string) => void }) => child.kill('SIGKILL'))
vi.mock('./wiki-generation-process', () => ({
  killProcessTree: (child: { kill: (signal: string) => void }) => killProcessTree(child)
}))

import { WikiGenerationService, type WikiGenerationServiceDeps } from './wiki-generation-service'

type MockChild = EventEmitter & {
  pid: number
  kill: ReturnType<typeof vi.fn>
  stdout: EventEmitter
  stderr: EventEmitter
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild
  child.pid = 4321
  child.kill = vi.fn()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

describe('WikiGenerationService', () => {
  let emitChanged: ReturnType<typeof vi.fn<WikiGenerationServiceDeps['emitChanged']>>
  let spawnAgent: ReturnType<typeof vi.fn<WikiGenerationServiceDeps['spawnAgent']>>
  let resolveBinary: ReturnType<typeof vi.fn<(agent: TuiAgent) => string>>
  let service: WikiGenerationService
  let child: MockChild

  beforeEach(() => {
    killProcessTree.mockClear()
    child = createMockChild()
    emitChanged = vi.fn()
    resolveBinary = vi.fn(() => 'claude')
    spawnAgent = vi.fn(() => child as unknown as ChildProcess)
    service = new WikiGenerationService({
      resolveBinary,
      emitChanged,
      spawnAgent,
      now: () => 1000
    })
  })

  it('starts a generation and reports running status', () => {
    const result = service.start({
      worktreeId: 'w1',
      cwd: '/repo',
      agent: 'claude',
      prompt: 'PROMPT'
    })
    expect(result).toEqual({ ok: true })
    expect(spawnAgent).toHaveBeenCalledWith({
      binary: 'claude',
      args: ['-p', '--dangerously-skip-permissions'],
      cwd: '/repo',
      prompt: 'PROMPT',
      promptViaStdin: true
    })
    expect(service.getStatus('w1')).toEqual({ running: true, output: '' })
  })

  it('appends stdout to output and emits changed with running:true', () => {
    service.start({ worktreeId: 'w1', cwd: '/repo', agent: 'claude', prompt: 'PROMPT' })
    child.stdout.emit('data', Buffer.from('generating...'))
    expect(service.getStatus('w1')).toEqual({ running: true, output: 'generating...' })
    expect(emitChanged).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      running: true,
      output: 'generating...'
    })
  })

  it('throttles rapid stdout emits by the injected clock, but always emits the terminal event', () => {
    // Why: now() is a counter here (not the fixed 1000 from beforeEach) so we can
    // observe both a throttled chunk (same timestamp) and an un-throttled one
    // (>= WIKI_GENERATION_EMIT_INTERVAL_MS later) deterministically.
    let currentNow = 1000
    const throttledNow = vi.fn(() => currentNow)
    const throttledEmit = vi.fn<WikiGenerationServiceDeps['emitChanged']>()
    const throttledChild = createMockChild()
    const throttledSpawn = vi.fn(() => throttledChild as unknown as ChildProcess)
    const throttledService = new WikiGenerationService({
      resolveBinary,
      emitChanged: throttledEmit,
      spawnAgent: throttledSpawn,
      now: throttledNow
    })
    throttledService.start({ worktreeId: 'w1', cwd: '/repo', agent: 'claude', prompt: 'PROMPT' })
    throttledChild.stdout.emit('data', Buffer.from('a'))
    throttledChild.stdout.emit('data', Buffer.from('b')) // same timestamp -> coalesced
    expect(throttledEmit).toHaveBeenCalledTimes(1)
    expect(throttledEmit).toHaveBeenLastCalledWith({ worktreeId: 'w1', running: true, output: 'a' })

    currentNow += 200
    throttledChild.stdout.emit('data', Buffer.from('c'))
    expect(throttledEmit).toHaveBeenCalledTimes(2)
    expect(throttledEmit).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      running: true,
      output: 'abc'
    })

    // Terminal event must never be throttled, even without the clock advancing.
    throttledChild.emit('close', 0)
    expect(throttledEmit).toHaveBeenCalledTimes(3)
    expect(throttledEmit).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      running: false,
      output: 'abc',
      done: true
    })
  })

  it('emits done:true and clears status when the process closes with code 0', () => {
    service.start({ worktreeId: 'w1', cwd: '/repo', agent: 'claude', prompt: 'PROMPT' })
    child.stdout.emit('data', Buffer.from('done'))
    child.emit('close', 0)
    expect(emitChanged).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      running: false,
      output: 'done',
      done: true
    })
    expect(service.getStatus('w1')).toBeNull()
  })

  it('records an error status when the process closes with a nonzero code', () => {
    service.start({ worktreeId: 'w1', cwd: '/repo', agent: 'claude', prompt: 'PROMPT' })
    child.stderr.emit('data', Buffer.from('boom'))
    child.emit('close', 1)
    expect(emitChanged).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      running: false,
      output: 'boom',
      error: 'Generation exited with code 1.'
    })
    expect(service.getStatus('w1')).toEqual({
      running: false,
      output: 'boom',
      error: 'Generation exited with code 1.'
    })
  })

  it('cancels a running generation, kills the process, and preserves accumulated output', () => {
    service.start({ worktreeId: 'w1', cwd: '/repo', agent: 'claude', prompt: 'PROMPT' })
    child.stdout.emit('data', Buffer.from('partial output'))
    service.cancel('w1')
    expect(killProcessTree).toHaveBeenCalledWith(child)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', 137)
    expect(emitChanged).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      running: false,
      output: 'partial output',
      done: true
    })
    expect(service.getStatus('w1')).toBeNull()
  })

  it('returns ok:false for an unsupported agent without spawning', () => {
    const result = service.start({
      worktreeId: 'w1',
      cwd: '/repo',
      agent: 'aider',
      prompt: 'PROMPT'
    })
    expect(result).toEqual({
      ok: false,
      error: 'Agent "aider" does not support background wiki generation.'
    })
    expect(spawnAgent).not.toHaveBeenCalled()
  })

  it('is idempotent when starting twice while already running', () => {
    service.start({ worktreeId: 'w1', cwd: '/repo', agent: 'claude', prompt: 'PROMPT' })
    const second = service.start({
      worktreeId: 'w1',
      cwd: '/repo',
      agent: 'claude',
      prompt: 'PROMPT'
    })
    expect(second).toEqual({ ok: true })
    expect(spawnAgent).toHaveBeenCalledTimes(1)
  })
})
