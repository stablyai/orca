import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_IMPORT_EXTENSION_ID, deriveChromeExtensionId } from './chat-import-extension'

// Why: JSON import 설정에 의존하지 않도록 매니페스트를 직접 읽어 key만 취한다.
const manifestKey = (
  JSON.parse(
    readFileSync(join(__dirname, '../../../extensions/chat-import/manifest.json'), 'utf-8')
  ) as { key: string }
).key

describe('deriveChromeExtensionId', () => {
  it('produces a deterministic 32-char a–p id', () => {
    const id = deriveChromeExtensionId(manifestKey)
    expect(id).toMatch(/^[a-p]{32}$/)
    expect(deriveChromeExtensionId(manifestKey)).toBe(id)
  })
  it('matches the committed constant (manifest key ↔ CHAT_IMPORT_EXTENSION_ID)', () => {
    expect(deriveChromeExtensionId(manifestKey)).toBe(CHAT_IMPORT_EXTENSION_ID)
  })
})
