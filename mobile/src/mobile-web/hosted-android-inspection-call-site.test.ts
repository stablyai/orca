import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const shellAndroidMain = fileURLToPath(
  new URL('../../packages/expo-mobile-web-shell/android/src/main', import.meta.url)
)
const DEVTOOLS_SWITCH = 'setWebContentsDebuggingEnabled('
const POLICY_GATED_CALL =
  'WebView.setWebContentsDebuggingEnabled(isMobileWebInspectionEnabled(applicationFlags))'

describe('Android WebView DevTools call site', () => {
  it('routes the only DevTools switch in the shell through the inspection policy', () => {
    const callSites = kotlinSources().flatMap(({ path, source }) =>
      source
        .split('\n')
        .map((line, index) => ({ path, line: line.trim(), lineNumber: index + 1 }))
        .filter((entry) => entry.line.includes(DEVTOOLS_SWITCH))
    )

    // Presence, not just absence: an unconditional call, or no call at all, must both fail.
    expect(callSites).toEqual([
      {
        path: join('java', 'expo', 'modules', 'mobilewebshell', 'MobileWebDebugIsolationProbe.kt'),
        line: POLICY_GATED_CALL,
        lineNumber: expect.any(Number)
      }
    ])
  })

  it('passes the build config defaults into the policy at that call site', () => {
    // The one-argument overload is what binds BuildConfig.DEBUG and ORCA_INSPECTABLE_RELEASE.
    expect(POLICY_GATED_CALL).toContain('isMobileWebInspectionEnabled(applicationFlags)')
    expect(POLICY_GATED_CALL).not.toContain('isDebugBuild')
    expect(POLICY_GATED_CALL).not.toContain('isInspectableRelease')
  })
})

function kotlinSources(): { path: string; source: string }[] {
  const sources = listFiles(shellAndroidMain)
    .filter((path) => path.endsWith('.kt'))
    .map((path) => ({ path: relative(shellAndroidMain, path), source: readFileSync(path, 'utf8') }))
  expect(sources.length).toBeGreaterThan(5)
  return sources
}

function listFiles(root: string): string[] {
  const paths: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) {
      continue
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (statSync(path).isDirectory()) {
        pending.push(path)
      } else {
        paths.push(path)
      }
    }
  }
  return paths
}
