import type { DictationCorrectionMode } from '../../../src/shared/speech-types'
import type { MobileDictationTranscriptPreview } from '../hooks/mobile-dictation-session-state'

type RuntimeDictationFinishResult = {
  text?: unknown
  rawText?: unknown
  correctedText?: unknown
  dictationCorrectionMode?: unknown
}

export type ResolvedMobileDictationFinishResult = {
  text: string
  preview: MobileDictationTranscriptPreview | null
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRuntimeCorrectionMode(value: unknown): DictationCorrectionMode | null {
  return value === 'off' || value === 'preview' || value === 'auto' ? value : null
}

export function resolveMobileDictationFinishResult(
  value: unknown,
  fallbackMode: DictationCorrectionMode
): ResolvedMobileDictationFinishResult {
  const result = (value ?? {}) as RuntimeDictationFinishResult
  const responseText = readText(result.text)
  const rawText = readText(result.rawText) || responseText
  const correctedText = readText(result.correctedText) || responseText
  const correctionMode = readRuntimeCorrectionMode(result.dictationCorrectionMode) ?? fallbackMode
  const text = correctionMode === 'auto' ? correctedText || rawText : rawText || responseText
  const preview =
    correctionMode === 'preview' && rawText && correctedText && rawText !== correctedText
      ? { rawText, correctedText }
      : null

  return { text, preview }
}
