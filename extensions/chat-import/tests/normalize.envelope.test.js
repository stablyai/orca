// tests/normalize.envelope.test.js
import { test, expect } from 'vitest'
import { parseBatchEnvelope } from '../lib/normalize.js'

test('parseBatchEnvelope extracts inner json by rpcid, multibyte-safe', () => {
  const inner = [
    ['c_1', '한글 제목'],
    ['c_2', 'x']
  ]
  // 바이트길이는 UTF-8 바이트 기준(코드유닛과 다름)이지만 파서는 무시해야 함
  const escaped = JSON.stringify(JSON.stringify(inner))
  const raw = ')]}\'\n\n99999\n[["wrb.fr","MaZiqc",' + escaped + ',null,null,null,"generic"]]'
  expect(parseBatchEnvelope(raw, 'MaZiqc')).toEqual(inner)
})

test('parseBatchEnvelope returns null for missing rpcid', () => {
  const raw = ')]}\'\n\n5\n[["wrb.fr","other","[]",null]]'
  expect(parseBatchEnvelope(raw, 'MaZiqc')).toBe(null)
})
