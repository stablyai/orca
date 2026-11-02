import { describe, expect, it } from 'vitest'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

describe('isTestOnlySourcePath', () => {
  it('matches specs, helpers and doubles beside a spec, and test directories', () => {
    for (const file of [
      'src/main/a/reader.test.ts',
      'src/main/a/reader.spec.tsx',
      'src/main/a/reader.test-support.ts',
      'src/main/a/structured-agent-session-rest-test-rig.ts',
      'src/main/a/structured-agent-session-host-test-data.ts',
      'src/main/a/ipc-events-test-fixtures.ts',
      'src/main/a/routing-fixture.ts',
      'src/main/a/codex-turn-lifecycle-fake.ts',
      'src/main/a/github-ipc-module-mocks.ts',
      'src/main/a/settled-pty-write-stub.ts',
      'src/main/a/subscription-registry-test-double.ts',
      'src/main/a/__tests__/reader.ts',
      'src/main/a/__fixtures__/reader.ts',
      'src/main/a/test-support/reader.ts',
      'src/main/runtime/orca-runtime-tests/setup.ts',
      'src/main/runtime/orca-runtime-test-mocks/store.ts'
    ]) {
      expect(isTestOnlySourcePath(file), file).toBe(true)
    }
  })

  it('keeps shipped modules whose names merely mention testing or fixtures', () => {
    for (const file of [
      'src/shared/relay-runtime-self-test-report.ts',
      'src/main/ssh/ssh-relay-runtime-self-test.ts',
      'src/main/ipc/local-network-connection-test.ts',
      'src/main/updater/latest-release.ts',
      'src/renderer/src/components/browser-pane/fixture-picker.tsx',
      'src/renderer/src/components/settings/fixtures-panel.tsx',
      'src/main/contest/entry.ts'
    ]) {
      expect(isTestOnlySourcePath(file), file).toBe(false)
    }
  })
})
