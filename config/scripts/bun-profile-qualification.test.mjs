import { expect, it } from 'vitest'
import { BUN_PERSISTENCE_RUNNERS, bunProfileQualification } from './bun-profile-qualification.mjs'

const draft = { pull_request: { draft: true } }
const scope = { shouldRun: true }

it('defers only platform qualification for ordinary draft runtime changes', () => {
  expect(
    bunProfileQualification(['src/main/runtime/rpc/methods/example.ts'], scope, draft)
  ).toEqual({
    qualification: false,
    runners: ['ubuntu-22.04']
  })
})

it.each([
  'package.json',
  'native/windows-registry/src/addon.cc',
  'config/vitest.config.ts',
  'src/main/ssh/ssh-provider.ts',
  'src/main/providers/local-pty-provider.ts',
  'src/shared/child-process/run-process.ts',
  'src/main/persistence/profile-state/store.ts',
  'src/main/sqlite/database.ts',
  'src/main/orcad/entry.ts',
  'src/main/runtime/windows-terminal.ts',
  'src/shared/linux-glibc.ts',
  'src/main/daemon/entry.ts',
  'src/relay/index.ts',
  'src/main/wsl/runner.ts'
])('retains all platforms for sensitive input %s', (file) => {
  expect(bunProfileQualification([file], scope, draft)).toEqual({
    qualification: true,
    runners: BUN_PERSISTENCE_RUNNERS
  })
})

it('qualifies every ready commit, scheduled/manual runs and incomplete evidence', () => {
  const paths = ['src/main/runtime/rpc/methods/example.ts']
  for (const event of [{}, { pull_request: { draft: false } }]) {
    expect(bunProfileQualification(paths, scope, event).qualification).toBe(true)
  }
  expect(bunProfileQualification([], scope, draft).qualification).toBe(true)
  expect(
    bunProfileQualification(paths, { ...scope, graphUnavailable: true }, draft).qualification
  ).toBe(true)
})
