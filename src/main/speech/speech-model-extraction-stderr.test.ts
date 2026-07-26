import { describe, expect, it } from 'vitest'
import {
  SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES,
  SpeechModelExtractionStderr
} from './speech-model-extraction-stderr'

describe('speech model extraction stderr', () => {
  it('preserves ordinary error evidence exactly', () => {
    const stderr = new SpeechModelExtractionStderr()
    stderr.append(Buffer.from('tar: archive is corrupt\n'))
    stderr.append(Buffer.from('tar: exiting with failure'))

    expect(stderr.errorEvidence()).toBe('tar: archive is corrupt\ntar: exiting with failure')
    expect(stderr.retainedByteLength()).toBe(49)
    expect(stderr.wasTruncated()).toBe(false)
  })

  it('retains the exact byte limit without truncation', () => {
    const stderr = new SpeechModelExtractionStderr()
    stderr.append(Buffer.alloc(SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES, 0x61))

    expect(stderr.retainedByteLength()).toBe(SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES)
    expect(stderr.wasTruncated()).toBe(false)
    expect(stderr.errorEvidence()).toBe('a'.repeat(500))
  })

  it('caps one byte over the limit while preserving prefix and tail evidence', () => {
    const stderr = new SpeechModelExtractionStderr()
    stderr.append(Buffer.alloc(SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES, 0x61))
    stderr.append(Buffer.from('Z'))

    expect(stderr.retainedByteLength()).toBe(SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES)
    expect(stderr.wasTruncated()).toBe(true)
    expect(stderr.errorEvidence()).toMatch(
      /^a{500}\n\[\.\.\. 1 stderr bytes omitted \.\.\.\]\na{499}Z$/
    )
  })

  it('bounds a single oversized chunk without converting it to an oversized string', () => {
    const stderr = new SpeechModelExtractionStderr()
    const chunk = Buffer.concat([
      Buffer.from('PREFIX'),
      Buffer.alloc(SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES * 2, 0x78),
      Buffer.from('TAIL')
    ])

    stderr.append(chunk)

    expect(stderr.retainedByteLength()).toBe(SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES)
    expect(stderr.errorEvidence()).toContain('PREFIX')
    expect(stderr.errorEvidence()).toMatch(/TAIL$/)
  })
})
