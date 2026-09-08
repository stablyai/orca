import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('./run-packaged-hosted-mobile-webview-ssh-e2e.mjs', import.meta.url),
  'utf8'
)

describe('packaged hosted mobile WebView SSH runner', () => {
  it('builds the packaged renderer with its required E2E store bridge', () => {
    expect(source).toContain("VITE_EXPOSE_STORE: 'true'")
    expect(source).toContain("runPnpm(['run', 'build:desktop'], e2eBuildEnv)")
  })
})
