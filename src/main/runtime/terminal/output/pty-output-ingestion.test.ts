import { afterEach, expect, it, vi } from 'vitest'
import * as terminalEscape from '../../../../shared/terminal-escape-scanner'
import { registerBoundPty } from '../../bind-first-pane.test-fixture'
import { createInventoryRuntime, WORKTREE } from '../../pty-inventory-lifecycle-fixture'

afterEach(() => vi.restoreAllMocks())

it('scans only new setup bytes for the owning PTY, independently of unrelated PTY population', async () => {
  const createStrictScanner = terminalEscape.createStrictTerminalEscapeScanner
  function countScanner(observer: Parameters<typeof createStrictScanner>[0]) {
    const onText = vi.fn(observer.onText)
    const onControl = vi.fn(observer.onControl)
    const lexer = createStrictScanner({ onText, onControl })
    return { onText, onControl, observe: vi.spyOn(lexer, 'observe'), lexer }
  }
  const scanners: ReturnType<typeof countScanner>[] = []
  vi.spyOn(terminalEscape, 'createStrictTerminalEscapeScanner').mockImplementation((observer) => {
    const counted = countScanner(observer)
    scanners.push(counted)
    return counted.lexer
  })
  const chunk = 'x\x1b[31my\x1b[0m\n'
  const measurements: { bytes: number; population: number; dispatches: number }[] = []
  for (const population of [2, 20]) {
    for (const chunks of [8, 80]) {
      const { runtime } = createInventoryRuntime(async () => [])
      const ids = Array.from({ length: population + 2 }, (_, index) => `setup-output-${index}`)
      const observations = ids.map((id) => {
        runtime.onPtySpawned(id, `${id}-incarnation`, { setupToken: `native:${id}` })
        const claim = runtime.beginPtyRegistration(id, `${id}-incarnation`)
        if (!claim.setupObservation) {
          throw new Error('fresh spawn must retain its observation through admission')
        }
        return claim.setupObservation
      })
      const [completeId, gapId] = ids
      const [completeObservation, gapObservation] = observations
      const [completeWork, gapWork] = scanners.slice(-(population + 2))
      const unrelatedScans = observations
        .slice(2)
        .map((observation) => vi.spyOn(observation, 'scan'))
      const maps = [
        runtime['setupCompletionTokenByPtyId'],
        runtime['pendingPtyRegistrationIncarnations']
      ]
      const gets = maps.map((map) => vi.spyOn(map, 'get'))
      const enumerations = maps.flatMap((map) => [
        vi.spyOn(map, 'entries'),
        vi.spyOn(map, 'values'),
        vi.spyOn(map, 'keys'),
        vi.spyOn(map, 'forEach'),
        vi.spyOn(map, Symbol.iterator)
      ])
      const complete = vi.fn()
      const gapComplete = vi.fn()
      void completeObservation.completion.then(complete)
      void gapObservation.completion.then(gapComplete)
      try {
        for (const id of [completeId, gapId]) {
          registerBoundPty(runtime, id, WORKTREE, null, {
            tabId: `${id}-tab`,
            leafId: `${id}-leaf`,
            incarnationId: `${id}-incarnation`,
            setupCompletionToken: `native:${id}`
          })
        }
        for (const get of gets) {
          get.mockClear()
        }
        for (const enumerate of enumerations) {
          enumerate.mockClear()
        }
        const bytes = chunks * chunk.length
        for (let index = 1; index <= chunks; index++) {
          for (const id of [completeId, gapId]) {
            const before = gets.map((get) => get.mock.calls.length)
            runtime.onPtyData(id, chunk, index, chunk.length, false, index * chunk.length)
            for (const [mapIndex, get] of gets.entries()) {
              const calls = get.mock.calls.slice(before[mapIndex])
              expect(calls.length).toBeLessThanOrEqual(1)
              for (const args of calls) {
                expect(args).toEqual([id])
              }
            }
          }
        }
        await Promise.resolve()
        expect(complete).not.toHaveBeenCalled()
        expect(gapComplete).not.toHaveBeenCalled()
        expect(completeObservation.unknown).toBe(false)
        expect(gapObservation.unknown).toBe(false)
        for (const work of [completeWork, gapWork]) {
          expect(work.onText.mock.calls.length + work.onControl.mock.calls.length).toBe(bytes)
          expect(work.observe.mock.calls).toEqual(Array.from({ length: chunks }, () => [chunk]))
        }
        measurements.push({
          bytes,
          population,
          dispatches:
            completeWork.onText.mock.calls.length + completeWork.onControl.mock.calls.length
        })
        const receipt = `ORCA_SETUP_DONE:native:${completeId}:0;`
        runtime.onPtyData(completeId, receipt, 100, receipt.length, false, bytes + receipt.length)
        await expect(completeObservation.completion).resolves.toEqual({ exitCode: 0 })
        expect(complete).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 })
        expect(
          completeWork.onText.mock.calls.length + completeWork.onControl.mock.calls.length
        ).toBe(bytes + receipt.length)
        const gapReceipt = `ORCA_SETUP_DONE:native:${gapId}:0;`
        runtime.onPtyData(
          gapId,
          gapReceipt,
          100,
          gapReceipt.length,
          false,
          bytes + 1 + gapReceipt.length
        )
        expect(gapObservation.unknown).toBe(true)
        expect(gapWork.observe).toHaveBeenCalledTimes(chunks)
        for (const work of [completeWork, gapWork]) {
          work.observe.mockClear()
          work.onText.mockClear()
          work.onControl.mockClear()
        }
        for (const get of gets) {
          get.mockClear()
        }
        const postlude = chunk.repeat(10)
        for (let index = 1; index <= chunks; index++) {
          for (const [id, start] of [
            [completeId, bytes + receipt.length],
            [gapId, bytes + 1 + gapReceipt.length]
          ] as const) {
            const before = gets.map((get) => get.mock.calls.length)
            runtime.onPtyData(
              id,
              postlude,
              100 + index,
              postlude.length,
              false,
              start + index * postlude.length
            )
            for (const [mapIndex, get] of gets.entries()) {
              const calls = get.mock.calls.slice(before[mapIndex])
              expect(calls.length).toBeLessThanOrEqual(1)
              for (const args of calls) {
                expect(args).toEqual([id])
              }
            }
          }
        }
        await Promise.resolve()
        expect(complete).toHaveBeenCalledTimes(1)
        expect(gapComplete).not.toHaveBeenCalled()
        expect(gapObservation.unknown).toBe(true)
        for (const work of [completeWork, gapWork]) {
          expect(work.observe).not.toHaveBeenCalled()
          expect(work.onText).not.toHaveBeenCalled()
          expect(work.onControl).not.toHaveBeenCalled()
        }
        for (const scan of unrelatedScans) {
          expect(scan).not.toHaveBeenCalled()
        }
        for (const enumerate of enumerations) {
          expect(enumerate).not.toHaveBeenCalled()
        }
      } finally {
        for (const id of ids) {
          await runtime.onPtyExit(id, 0, `${id}-incarnation`, { providerExitObserved: true })
          runtime.cancelPendingPtyRegistration(id, `${id}-incarnation`)
        }
      }
    }
  }
  const [small, large, crowdedSmall, crowdedLarge] = measurements
  expect(large.bytes).toBe(10 * small.bytes)
  expect(large.dispatches).toBe(10 * small.dispatches)
  expect(crowdedSmall).toEqual({ ...small, population: 20 })
  expect(crowdedLarge).toEqual({ ...large, population: 20 })
})
