import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./use-mobile-dictation.ts', import.meta.url), 'utf8')

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
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

  it('reserves pending audio bytes before encoding microphone chunks', () => {
    const microphoneEffect = sliceBetween(
      "addExpoTwoWayAudioEventListener('onMicrophoneData'",
      'return () => sub.remove()'
    )

    const reserveIndex = microphoneEffect.indexOf('tryReserve(byteLength)')
    const encodeIndex = microphoneEffect.indexOf('bytesToBase64(bytes)')
    expect(reserveIndex).toBeGreaterThanOrEqual(0)
    expect(encodeIndex).toBeGreaterThanOrEqual(0)
    expect(reserveIndex).toBeLessThan(encodeIndex)
    expect(microphoneEffect).toContain('MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE')
    expect(microphoneEffect).toContain('pendingAudioBudgetRef.current.release(byteLength)')
  })

  it('resets pending audio bytes whenever pending chunk tracking is cleared', () => {
    const pendingChunkClears = source.match(/pendingChunksRef\.current\.clear\(\)/g) ?? []
    const pendingAudioResets = source.match(/pendingAudioBudgetRef\.current\.reset\(\)/g) ?? []

    expect(pendingAudioResets).toHaveLength(pendingChunkClears.length)
  })
})
