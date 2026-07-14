// tests/manifest.icons.test.js
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionDir = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'))

describe('chat-import manifest icons', () => {
  it('declares icons + action.default_icon and the files exist', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons[size]).toBe(`icons/icon-${size}.png`)
      expect(existsSync(join(extensionDir, manifest.icons[size]))).toBe(true)
      expect(manifest.action.default_icon[size]).toBe(`icons/icon-${size}.png`)
    }
  })
})
