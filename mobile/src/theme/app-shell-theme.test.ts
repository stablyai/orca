import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const MOBILE_ROOT = path.resolve(__dirname, '../..')

describe('app shell theme wiring', () => {
  it('wraps the root layout in ThemeProvider and flips StatusBar from resolved mode', () => {
    const source = fs.readFileSync(path.join(MOBILE_ROOT, 'app/_layout.tsx'), 'utf8')
    expect(source).toContain('<ThemeProvider>')
    expect(source).toContain("mode === 'light' ? 'dark' : 'light'")
    // Why banned: mode must stay an explicit field, never palette-identity.
    expect(source).not.toContain('=== lightColors')
  })

  it('routes the host group shell through useTheme / useThemedStyles', () => {
    const source = fs.readFileSync(path.join(MOBILE_ROOT, 'app/h/_layout.tsx'), 'utf8')
    expect(source).toContain('useThemedStyles')
    expect(source).toContain('useTheme')
    // Type-only ThemeColors import is fine; the bare `colors` binding must be gone.
    expect(source).not.toMatch(/import\s*\{[^}]*\bcolors\b[^}]*\}\s*from/)
  })
})
