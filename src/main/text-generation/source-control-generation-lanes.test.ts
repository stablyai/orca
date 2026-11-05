import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aliasLocalGenerationTargetPath,
  beginLocalGenerationRequest,
  beginTextGenerationRequest,
  cancelLocalGeneration,
  localGenerationRequestStop,
  type LocalGenerationRequest
} from './source-control-generation-lanes'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import { sourceControlSubscriptionTarget } from './source-control-subscription-target'

const cwd = '/same-worktree'
const live: LocalGenerationRequest[] = []
afterEach(() => {
  for (const request of live.splice(0)) {
    request.release()
  }
})

function identified(generationId: string, owner = 'desktop') {
  const request = beginLocalGenerationRequest('commit-message', { owner, generationId })!
  request.bindTarget({ cwd })
  live.push(request)
  return request
}

describe('text generation budgets', () => {
  it('two generations sharing one owner on the same worktree keep independent budgets', () => {
    const first = identified('first').startBudget({ cwd })
    const second = identified('second').startBudget({ cwd })
    expect(first.signal.aborted).toBe(false)
    expect(first.current()).toBe(true)
    expect(second.current()).toBe(true)
  })

  it('a legacy same-lane request still replaces and fences its predecessor', () => {
    const first = beginTextGenerationRequest('branch-name', cwd, 60_000, () => true, undefined, 'w')
    const second = beginTextGenerationRequest(
      'branch-name',
      cwd,
      60_000,
      () => true,
      undefined,
      'w'
    )
    expect(first.signal.reason).toBe('canceled')
    expect(first.ownsResult()).toBe(false)
    expect(second.current()).toBe(true)
    second.finish()
  })

  it('without a prepared subscription the request keeps no budget and its legacy Stop path', () => {
    const registration = identified('no-failover')
    let prepared = 0
    const target = sourceControlSubscriptionTarget(
      { kind: 'local', cwd, env: { PATH: '/bin' }, generationRequest: registration },
      { agentId: 'claude', model: 'sonnet' },
      {
        prepareTextSubscriptionFailover: () => {
          prepared++
          return undefined
        }
      },
      async () => true
    )
    expect(prepared).toBe(1)
    expect(target.request).toBeUndefined()
    expect(registration.budget).toBeUndefined()
    let stopped = false
    registration.attachCancelToken(() => {
      stopped = true
    })
    registration.cancelForTarget({ cwd })
    expect(stopped).toBe(true)
  })

  it('a request bound before a folder move stops for either path', () => {
    const moved = identified('moved')
    const other = identified('moved-other')
    aliasLocalGenerationTargetPath(cwd, '/renamed-worktree')
    moved.cancelForTarget({ cwd: '/renamed-worktree' })
    expect(moved.canceled).toBe(true)
    other.cancelForTarget({ cwd: '/unrelated' })
    expect(other.canceled).toBe(false)
    other.cancelForTarget({ cwd })
    expect(other.canceled).toBe(true)
  })

  it('a legacy path Stop also stops identified requests of that operation on that path', () => {
    const onPath = identified('path-stop')
    const elsewhere = beginLocalGenerationRequest('commit-message', {
      owner: 'desktop',
      generationId: 'path-stop-elsewhere'
    })!
    live.push(elsewhere)
    elsewhere.bindTarget({ cwd: '/other-worktree' })
    let processStopped = false
    onPath.attachCancelToken(() => {
      processStopped = true
    })
    cancelLocalGeneration('pull-request-fields', cwd)
    expect(onPath.canceled).toBe(false)
    cancelLocalGeneration('commit-message', cwd)
    expect(onPath.canceled).toBe(true)
    expect(processStopped).toBe(true)
    expect(elsewhere.canceled).toBe(false)
  })

  it('concurrent validations share one target probe and still observe a later Stop', async () => {
    let release!: (value: boolean) => void
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    const request = beginTextGenerationRequest('commit-message', cwd, 60_000, () => true, probe)
    const first = request.validate()
    const second = request.validate()
    await Promise.resolve()
    request.cancel()
    release(true)
    expect(await Promise.all([first, second])).toEqual([false, false])
    expect(probe).toHaveBeenCalledOnce()
    request.finish()
  })

  it('a folder move keeps the WSL runtime of the bound path', () => {
    const request = beginLocalGenerationRequest('commit-message', {
      owner: 'desktop',
      generationId: 'wsl-moved'
    })!
    live.push(request)
    request.bindTarget({ cwd, wslDistro: 'Ubuntu' })
    aliasLocalGenerationTargetPath(cwd, '/renamed-worktree')
    request.cancelForTarget({ cwd: '/renamed-worktree' })
    expect(request.canceled).toBe(false)
    request.cancelForTarget({ cwd: '/renamed-worktree', wslDistro: 'Ubuntu' })
    expect(request.canceled).toBe(true)
  })
})

describe('Stop before Generate registers', () => {
  it('expires after the generation timeout', () => {
    vi.useFakeTimers()
    try {
      localGenerationRequestStop('commit-message', { owner: 'desktop', generationId: 'late' })({
        cwd
      })
      vi.advanceTimersByTime(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
      expect(identified('late').canceled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a bounded number of early Stops, dropping the oldest', () => {
    for (let index = 0; index <= 64; index++) {
      localGenerationRequestStop('commit-message', {
        owner: 'desktop',
        generationId: `flood-${index}`
      })({ cwd })
    }
    expect(identified('flood-0').canceled).toBe(false)
    expect(identified('flood-64').canceled).toBe(true)
  })
})
