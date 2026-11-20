import { describe, expect, it, vi } from 'vitest'
import {
  resolveCodexHomeProcessLockKeyForSpawnEnv,
  withCodexHomeProcessLock
} from '../../codex-cli/codex-home-process-lock'
import type { GenerationAdmission } from './background-generation-slots'
import { runLocalPlanForAgent } from './source-control-local-generation'

// #45703: naming that waits on a busy Codex account must not hold a slot other chats need.
describe('background naming admission under the Codex home lock', () => {
  it('enters the naming slot only once the account lock is free', async () => {
    const env = { CODEX_HOME: '/orca-test/codex-home-busy', PATH: '' }
    const lockFree = Promise.withResolvers<void>()
    const otherHolder = withCodexHomeProcessLock(
      resolveCodexHomeProcessLockKeyForSpawnEnv(env, null),
      () => lockFree.promise
    )
    let admissions = 0
    const admit: GenerationAdmission = async () => {
      admissions++
      return null
    }
    const result = runLocalPlanForAgent({
      agentId: 'codex',
      plan: { binary: 'codex', args: [], stdinPayload: null, label: 'Codex' },
      target: { kind: 'local', cwd: '/orca-test/workspace', env },
      operation: 'conversation-name',
      spawnAgent: () => {
        throw new Error('a refused admission starts no agent')
      },
      admit
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(admissions).toBe(0)

    lockFree.resolve()
    await otherHolder
    await expect(result).resolves.toMatchObject({ success: false, canceled: true })
    expect(admissions).toBe(1)
  })

  it('gives a run that gave its slot back for a busy account the next slot', async () => {
    vi.resetModules()
    const { BackgroundGenerationRequest } = await import('./background-generation-slots')
    const started: string[] = []
    const closers: (() => void)[] = []
    const launch = (label: string, returning = false) =>
      new BackgroundGenerationRequest().admitWhile(() => true)(
        () => {
          started.push(label)
          const closed = Promise.withResolvers<void>()
          closers.push(closed.resolve)
          return { processClosed: closed.promise }
        },
        { returning }
      )
    void launch('a')
    void launch('b')
    void launch('c')
    void launch('queued background run')
    void launch('returning run', true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['a', 'b', 'c'])

    closers[0]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['a', 'b', 'c', 'returning run'])
  })

  it('leaves the Codex account free for other work while a naming run waits for a slot', async () => {
    vi.resetModules()
    const { BackgroundGenerationRequest } = await import('./background-generation-slots')
    const closers: (() => void)[] = []
    for (let i = 0; i < 3; i++) {
      void new BackgroundGenerationRequest().admitWhile(() => true)(() => {
        const closed = Promise.withResolvers<void>()
        closers.push(closed.resolve)
        return { processClosed: closed.promise }
      })
    }
    const env = { CODEX_HOME: '/orca-test/codex-home-queued', PATH: '' }
    void runLocalPlanForAgent({
      agentId: 'codex',
      plan: { binary: 'codex', args: [], stdinPayload: null, label: 'Codex' },
      target: { kind: 'local', cwd: '/orca-test/workspace', env },
      operation: 'conversation-name',
      spawnAgent: () => {
        throw new Error('this naming run never reaches a slot')
      },
      admit: new BackgroundGenerationRequest().admitWhile(() => false)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const foregroundRan = await Promise.race([
      withCodexHomeProcessLock(
        resolveCodexHomeProcessLockKeyForSpawnEnv(env, null),
        async () => true
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
    ])
    expect(foregroundRan).toBe(true)
    for (const close of closers) {
      close()
    }
  })

  it.each([100, 1000])(
    'admits each of %i same-account naming runs once while they wait their turn',
    async (runs) => {
      vi.resetModules()
      const { BackgroundGenerationRequest } = await import('./background-generation-slots')
      const lock = await import('../../codex-cli/codex-home-process-lock')
      const { admitUnderFreeCodexHome } = await import('./codex-home-generation-admission')
      const lockKey = '/orca-test/codex-home-shared'
      const running: (() => void)[] = []
      let admissions = 0
      let finished = 0
      const all = Array.from({ length: runs }, () => {
        const request = new BackgroundGenerationRequest()
        const admit = request.admitWhile(() => true)
        return admitUnderFreeCodexHome(
          (start, options) => {
            admissions++
            return admit(start, options)
          },
          lockKey,
          () => {
            const closed = Promise.withResolvers<void>()
            const held = lock.withCodexHomeProcessLock(lockKey, () => closed.promise)
            running.push(closed.resolve)
            return {
              result: Promise.resolve({ success: true as const, rawOutput: 'name' }),
              processClosed: held
            }
          }
        ).then(() => {
          finished++
        })
      })
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
      await tick()
      for (let step = 0; finished < runs && step < runs * 4; step++) {
        running.shift()?.()
        await tick()
      }
      await Promise.all(all)
      for (const close of running) {
        close()
      }
      expect(admissions).toBe(runs)
    }
  )
})
