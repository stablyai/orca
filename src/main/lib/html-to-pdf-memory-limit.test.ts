import { describe, expect, it } from 'vitest'
import {
  assertHtmlToPdfInputWithinMemoryLimit,
  HTML_TO_PDF_MEMORY_LIMIT_ERROR
} from './html-to-pdf-memory-limit'

describe('HTML to PDF memory limit', () => {
  it('measures UTF-8 bytes and accepts the boundary', () => {
    expect(() => assertHtmlToPdfInputWithinMemoryLimit('éé', 4)).not.toThrow()
  })

  it('rejects the next byte', () => {
    expect(() => assertHtmlToPdfInputWithinMemoryLimit('ééa', 4)).toThrow(
      HTML_TO_PDF_MEMORY_LIMIT_ERROR
    )
  })
})
