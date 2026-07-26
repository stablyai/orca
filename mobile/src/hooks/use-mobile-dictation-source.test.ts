import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./use-mobile-dictation.ts', import.meta.url), 'utf8')
const audioChunkSource = readFileSync(
  new URL('./mobile-dictation-audio-chunk.ts', import.meta.url),
  'utf8'
)
const keepAwakeSource = readFileSync(
  new URL('./mobile-dictation-keep-awake.ts', import.meta.url),
  'utf8'
)
const desktopStartSource = readFileSync(
  new URL('./mobile-dictation-desktop-start.ts', import.meta.url),
  'utf8'
)
const sessionStateSource = readFileSync(
  new URL('./mobile-dictation-session-state.ts', import.meta.url),
  'utf8'
)
const foregroundKeepAwakeSource = readFileSync(
  new URL('./mobile-dictation-foreground-keep-awake.ts', import.meta.url),
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

function sliceDesktopStartBetween(startPattern: string, endPattern: string): string {
  return sliceSource(desktopStartSource, startPattern, endPattern)
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
    const microphoneEffect = sliceSource(
      audioChunkSource,
      'export function enqueueMobileDictationAudioChunk',
      '  queue.pendingChunks.add(sendChunk)'
    )

    const reserveIndex = microphoneEffect.indexOf('tryReserve(byteLength)')
    const encodeIndex = microphoneEffect.indexOf('bytesToBase64(bytes)')
    expect(reserveIndex).toBeGreaterThanOrEqual(0)
    expect(encodeIndex).toBeGreaterThanOrEqual(0)
    expect(reserveIndex).toBeLessThan(encodeIndex)
    expect(microphoneEffect).toContain('MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE')
    expect(microphoneEffect).toContain('queue.pendingAudioBudget.release(byteLength)')
    expect(source).toContain('enqueueMobileDictationAudioChunk(client, dictationId, event')
  })

  it('reuses audio chunk queue wiring across microphone events', () => {
    const queueIndex = source.indexOf('const audioChunkQueue =')
    const listenerIndex = source.indexOf("addExpoTwoWayAudioEventListener('onMicrophoneData'")

    expect(queueIndex).toBeGreaterThanOrEqual(0)
    expect(queueIndex).toBeLessThan(listenerIndex)
    expect(source).toContain(
      'enqueueMobileDictationAudioChunk(client, dictationId, event, audioChunkQueue)'
    )
  })

  it('resets pending audio bytes whenever pending chunk tracking is cleared', () => {
    const pendingChunkClears = source.match(/pendingChunksRef\.current\.clear\(\)/g) ?? []
    const pendingAudioResets = source.match(/pendingAudioBudgetRef\.current\.reset\(\)/g) ?? []

    expect(pendingAudioResets).toHaveLength(pendingChunkClears.length)
  })

  it('keeps mobile dictation keep-awake ownership beside the hook', () => {
    expect(source).toMatch(
      /import \{[^}]*createMobileDictationKeepAwakeOwner[^}]*\} from '\.\/mobile-dictation-keep-awake'/
    )
    expect(source).toContain(
      'const keepAwakeOwner = useMemo(createMobileDictationKeepAwakeOwner, [])'
    )
    expect(keepAwakeSource).toContain('activateKeepAwakeAsync')
    expect(keepAwakeSource).toContain('deactivateKeepAwake')
    expect(keepAwakeSource).not.toMatch(/\bactivateKeepAwake\s*\(/)
  })

  it('acquires keep-awake only after desktop start and stale-start guards', () => {
    const hookStartBody = sliceBetween('const start = useCallback(async () => {', 'const stop =')
    const startBody = sliceDesktopStartBetween(
      'export async function startMobileDictationDesktopSession',
      '  return true'
    )
    const desktopStartIndex = startBody.indexOf(
      "client.sendRequest('speech.dictation.start', { dictationId })"
    )
    const acquireIndex = startBody.indexOf('.acquire(dictationId)')
    const desktopSessionIndex = hookStartBody.indexOf('await startMobileDictationDesktopSession')
    const toggleRecordingIndex = hookStartBody.indexOf('toggleRecording(true)')

    expect(desktopStartIndex).toBeGreaterThanOrEqual(0)
    expect(acquireIndex).toBeGreaterThan(desktopStartIndex)
    expect(desktopSessionIndex).toBeGreaterThanOrEqual(0)
    expect(toggleRecordingIndex).toBeGreaterThan(desktopSessionIndex)
    expect(hookStartBody).toContain('commitRecordingStart: () => {')
    expect(startBody).toContain('options.commitRecordingStart()')

    const beforeAcquire = startBody.slice(desktopStartIndex, acquireIndex)
    expect(beforeAcquire).toContain('isCurrentStart(options)')
    expect(desktopStartSource).toContain('options.getCurrentGeneration()')
    expect(desktopStartSource).toContain('options.getEnabled()')
    expect(desktopStartSource).toContain('options.getActiveId()')
    expect(sessionStateSource).toContain(
      'currentGeneration === generation && enabled && activeId === dictationId'
    )
  })

  it('re-checks stale-start guards after awaited keep-awake acquisition', () => {
    const startBody = sliceDesktopStartBetween(
      'export async function startMobileDictationDesktopSession',
      '  return true'
    )
    const acquireIndex = startBody.indexOf('.acquire(dictationId)')
    const returnStartedIndex = startBody.indexOf('return true')
    const afterAcquire = startBody.slice(acquireIndex, returnStartedIndex)

    expect(afterAcquire).toContain('isCurrentStart(options)')
    expect(desktopStartSource).toContain('options.getCurrentGeneration()')
    expect(desktopStartSource).toContain('options.getEnabled()')
    expect(desktopStartSource).toContain('options.getActiveId()')
    expect(afterAcquire).toContain('await cancelStaleStart(options, { releaseKeepAwake: true })')

    // The stale-start cleanup must release the wake tag and cancel the desktop
    // session (concurrently, so a hung acquisition can't delay the cancel).
    const cancelStaleStartBody = sliceDesktopStartBetween(
      'async function cancelStaleStart',
      'export async function startMobileDictationDesktopSession'
    )
    expect(cancelStaleStartBody).toContain(
      "client.sendRequest('speech.dictation.cancel', { dictationId })"
    )
    expect(cancelStaleStartBody).toContain('cleanups.push(keepAwakeOwner.release(dictationId))')
    expect(cancelStaleStartBody).toContain('await Promise.allSettled(cleanups)')
  })

  it('treats keep-awake acquisition as best-effort for the desktop session', () => {
    const startBody = sliceDesktopStartBetween(
      'export async function startMobileDictationDesktopSession',
      '  return true'
    )
    const acquireIndex = startBody.indexOf('.acquire(dictationId)')
    expect(acquireIndex).toBeGreaterThanOrEqual(0)
    const staleCheckIndex = startBody.indexOf('isCurrentStart(options)', acquireIndex)
    expect(staleCheckIndex).toBeGreaterThan(acquireIndex)

    // An acquisition failure must not cancel the dictation or surface an error.
    const acquireChain = startBody.slice(acquireIndex, staleCheckIndex)
    expect(acquireChain).toContain('.catch(')
    expect(acquireChain).not.toContain('throw')
  })

  it('releases keep-awake on all dictation cleanup paths without delaying recording shutdown', () => {
    const closeAudio = sliceBetween(
      'const closeDictationAudio = useCallback(',
      'const failActiveDictation ='
    )
    expect(closeAudio.indexOf('toggleRecording(false)')).toBeLessThan(
      closeAudio.indexOf('void keepAwakeOwner.release')
    )
    expect(closeAudio).toContain('.catch(() => undefined)')

    const cleanupSlices = [
      sliceBetween('const failActiveDictation = useCallback(', 'useEffect(() => {'),
      sliceBetween('const cancel = useCallback(async () => {', 'useEffect(() => {\n    const sub'),
      sliceBetween('return () => {\n      const dictationId = activeIdRef.current', '  return {')
    ]

    for (const cleanupSlice of cleanupSlices) {
      expect(cleanupSlice).toContain('closeDictationAudio(dictationId)')
    }

    const stopBody = sliceBetween('const stop = useCallback(async () => {', 'const cancel =')
    expect(stopBody.indexOf('toggleRecording(false)')).toBeLessThan(
      stopBody.indexOf('await Promise.allSettled')
    )
    // The wake tag must be held through chunk drain and the finish RPC so a
    // screen lock cannot suspend the app before the transcript arrives.
    expect(stopBody.indexOf('speech.dictation.finish')).toBeLessThan(
      stopBody.indexOf('void keepAwakeOwner.release')
    )
    expect(stopBody.indexOf('} finally {')).toBeLessThan(
      stopBody.indexOf('void keepAwakeOwner.release')
    )
  })

  it('reacquires the wake tag when Android returns to the foreground mid-dictation', () => {
    expect(source).toContain('useMobileDictationForegroundKeepAwake(keepAwakeOwner, activeIdRef)')
    expect(foregroundKeepAwakeSource).toContain("Platform.OS !== 'android'")
    expect(foregroundKeepAwakeSource).toContain('keepAwakeOwner.reacquire(dictationId)')
    // A transiently failing refresh retries while the dictation is live.
    expect(foregroundKeepAwakeSource).toContain('REACQUIRE_RETRY_DELAYS_MS[attempt]')
    expect(foregroundKeepAwakeSource).toContain('activeIdRef.current === dictationId')
    // Stale-tag retries survive hook unmount via a module-level listener.
    expect(foregroundKeepAwakeSource).toContain('installGlobalStaleTagForegroundDrain()')
    expect(foregroundKeepAwakeSource).toContain('drainMobileDictationKeepAwakeCleanup()')

    // Native activate skips re-applying the window flag while any tag remains,
    // so reacquire must deactivate before activating.
    const reacquireBody = sliceSource(
      keepAwakeSource,
      'reacquire(dictationId: string)',
      'release(dictationId?: string)'
    )
    expect(reacquireBody.indexOf('await activateTrackedTag(tag,')).toBeGreaterThanOrEqual(0)
    expect(reacquireBody.indexOf('deactivateTrackedTag(tag)')).toBeGreaterThanOrEqual(0)
    expect(reacquireBody.indexOf('deactivateTrackedTag(tag)')).toBeLessThan(
      reacquireBody.indexOf('await activateTrackedTag(tag,')
    )
  })

  it('keeps cleanup going when native recording shutdown throws', () => {
    const closeAudio = sliceBetween(
      'const closeDictationAudio = useCallback(',
      'const failActiveDictation ='
    )
    const toggleIndex = closeAudio.indexOf('toggleRecording(false)')
    const catchIndex = closeAudio.indexOf('} catch', toggleIndex)
    const releaseIndex = closeAudio.indexOf('void keepAwakeOwner.release')
    expect(toggleIndex).toBeGreaterThanOrEqual(0)
    expect(catchIndex).toBeGreaterThan(toggleIndex)
    expect(catchIndex).toBeLessThan(releaseIndex)

    // stop()'s recording shutdown sits inside the try so a native throw still
    // runs the finally release and error cleanup.
    const stopBody = sliceBetween('const stop = useCallback(async () => {', 'const cancel =')
    expect(stopBody.indexOf('try {')).toBeGreaterThanOrEqual(0)
    expect(stopBody.indexOf('try {')).toBeLessThan(stopBody.indexOf('toggleRecording(false)'))
  })

  it('routes disabled state and audio interruptions through cancel cleanup', () => {
    const interruptionEffect = sliceBetween(
      "addExpoTwoWayAudioEventListener('onAudioInterruption'",
      'return () => sub.remove()'
    )
    const disabledEffect = sliceBetween(
      'useEffect(() => {\n    if (!enabled) {',
      '  }, [cancel, enabled])'
    )

    expect(interruptionEffect).toContain("event.data === 'began' || event.data === 'blocked'")
    expect(interruptionEffect).toContain('void cancel()')
    expect(disabledEffect).toContain('void cancel()')
  })

  it('uses per-owner dictation keep-awake tags and serializes async ownership changes', () => {
    expect(keepAwakeSource).toContain('private readonly ownerId = createOwnerId()')
    expect(keepAwakeSource).toContain(
      '`${MOBILE_DICTATION_KEEP_AWAKE_TAG_PREFIX}:${this.ownerId}:${dictationId}`'
    )
    expect(keepAwakeSource).toContain('let keepAwakeOperation: Promise<void> = Promise.resolve()')
    expect(keepAwakeSource).toContain('const pendingCleanupTags = new Set<string>()')
    expect(keepAwakeSource.match(/enqueueKeepAwakeOperation/g)?.length).toBeGreaterThanOrEqual(3)
    expect(keepAwakeSource).toContain(
      'const targetTag = dictationId ? this.createTag(dictationId) : null'
    )
    expect(keepAwakeSource).toContain('if (!tag || (targetTag && tag !== targetTag))')
    expect(keepAwakeSource).toContain('await cleanupPendingTags()')
  })
})
