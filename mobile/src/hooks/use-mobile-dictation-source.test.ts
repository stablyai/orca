import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./use-mobile-dictation.ts', import.meta.url), 'utf8')
const nativeCaptureSource = readFileSync(
  new URL('../platform/dictation-capture.ts', import.meta.url),
  'utf8'
)

function sliceSource(sourceText: string, startPattern: string, endPattern: string): string {
  const start = sourceText.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sourceText.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return sourceText.slice(start, end)
}

function sliceBetween(startPattern: string, endPattern: string): string {
  return sliceSource(source, startPattern, endPattern)
}

describe('useMobileDictation source invariants', () => {
  it('publishes live option refs from committed renders before passive Effects flush', () => {
    const refDeclarations = sliceBetween(
      'const clientRef = useRef(client)',
      'useLayoutEffect(() => {'
    )
    expect(refDeclarations).not.toContain('.current =')

    const mirrorEffect = sliceBetween('useLayoutEffect(() => {', 'const reportError =')
    expect(mirrorEffect).toContain('clientRef.current = client')
    expect(mirrorEffect).toContain('enabledRef.current = enabled')
    expect(mirrorEffect).toContain('onTranscriptRef.current = onTranscript')
    expect(mirrorEffect).toContain('onErrorRef.current = onError')
    expect(mirrorEffect).toContain('}, [client, enabled, onTranscript, onError])')
  })

  it('carries audio the capture dropped into the same refusal the budget raises', () => {
    const chunkHandler = sliceBetween('const sub = capture.onChunk(', 'return () => sub.remove()')
    expect(chunkHandler).toContain('if (chunk.droppedBytes > 0)')
    expect(chunkHandler).toContain('MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE')
    // Only the page can drop: the seam's native half is where the microphone is.
    expect(nativeCaptureSource).toContain('droppedBytes: 0')
  })

  it('resets pending audio bytes whenever pending chunk tracking is cleared', () => {
    const pendingChunkClears = source.match(/pendingChunksRef\.current\.clear\(\)/g) ?? []
    const pendingAudioResets = source.match(/pendingAudioBudgetRef\.current\.reset\(\)/g) ?? []

    expect(pendingAudioResets).toHaveLength(pendingChunkClears.length)
  })

  it('closes the capture on every path that ends a dictation', () => {
    const closeAudio = sliceBetween(
      'const closeDictationAudio = useCallback(',
      'const failActiveDictation ='
    )
    expect(closeAudio).toContain('capture.end()')
    const cleanupSlices = [
      sliceBetween('const failActiveDictation = useCallback(', 'useEffect(() => {'),
      sliceBetween('const abandonDictation = useCallback(', 'const cancel ='),
      sliceBetween('return () => {\n      const dictationId = activeIdRef.current', '  return {')
    ]
    for (const cleanupSlice of cleanupSlices) {
      expect(cleanupSlice).toContain('closeDictationAudio()')
    }
    // The capture hands over its tail before the pending sends are taken, or the finish overtakes
    // the last chunk. `mobile-dictation-stop-tail.test.tsx` drives the order this pins.
    const stopBody = sliceBetween(
      'const stop = useCallback(async () => {',
      'const abandonDictation ='
    )
    expect(stopBody.indexOf('capture.end()')).toBeLessThan(
      stopBody.indexOf('await Promise.allSettled')
    )
  })

  it('routes an audio interruption through cancel and a disable through the reporting abort', () => {
    const interruptionEffect = sliceBetween('capture.onInterruption(', 'return () => sub.remove()')
    const disabledEffect = sliceBetween(
      'useEffect(() => {\n    if (!enabled) {',
      '  }, [abandonDictation, enabled])'
    )

    expect(interruptionEffect).toContain('void cancel()')
    // A disable is not the user's cancel, so it carries the reason the composer shows; the user's
    // own cancel is the one end that passes none. `mobile-dictation-input-closed-mid-start.test.tsx`
    // drives both halves.
    expect(disabledEffect).toContain(
      'void abandonDictation(MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE)'
    )
    expect(source).toContain('const cancel = useCallback(() => abandonDictation(null)')
    // Which interruptions end a capture is one predicate both seams read, so a page cannot cancel
    // on a kind the device ignores. `dictation-capture.test.ts` drives the rule itself.
    expect(nativeCaptureSource).toContain('bridgeAudioInterruptionEndsCapture(event.data)')
  })
})
