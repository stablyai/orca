import { describe, expect, it } from 'vitest'
import {
  clearProjectRefInFlight,
  PROJECT_REF_MAX_IN_FLIGHT,
  runProjectRefProbeOnce
} from './project-ref-inflight'

describe('GitLab project-ref in-flight probes', () => {
  it('caps retained probes and recovers coalescing after settlement', async () => {
    clearProjectRefInFlight()
    const releases: (() => void)[] = []
    const probes = Array.from({ length: PROJECT_REF_MAX_IN_FLIGHT }, (_, index) =>
      runProjectRefProbeOnce(
        `key-${index}`,
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve(null))
          })
      )
    )
    let overflowCalls = 0
    await expect(
      runProjectRefProbeOnce('overflow', async () => {
        overflowCalls += 1
        return null
      })
    ).resolves.toBeNull()
    await expect(
      runProjectRefProbeOnce('overflow', async () => {
        overflowCalls += 1
        return null
      })
    ).resolves.toBeNull()
    expect(overflowCalls).toBe(2)

    releases.forEach((release) => release())
    await Promise.all(probes)

    let retainedCalls = 0
    const first = runProjectRefProbeOnce('recovered', async () => {
      retainedCalls += 1
      return null
    })
    const second = runProjectRefProbeOnce('recovered', async () => {
      retainedCalls += 1
      return null
    })
    await Promise.all([first, second])
    expect(retainedCalls).toBe(1)
  })
})
