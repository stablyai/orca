import { expect, it } from 'vitest'
import { NODE_SERVER_RUNNERS, nodeServerQualification } from './node-server-qualification.mjs'

const scope = { shouldRun: true }

it('qualifies one platform for a change no platform can alter', () => {
  expect(nodeServerQualification(['src/main/runtime/rpc/methods/example.ts'], scope)).toEqual({
    qualification: false,
    runners: ['ubuntu-22.04']
  })
})

it.each([
  'src/renderer/src/components/TabStrip.tsx',
  'config/vitest.config.ts',
  'config/scripts/ci-unit-plan.mjs',
  'resources/icons/tray.png',
  '.github/workflows/pr.yml',
  'docs/reference/agent-status-store.md'
])('keeps one platform for unflavoured input %s', (file) => {
  expect(nodeServerQualification([file], scope).runners).toEqual(['ubuntu-22.04'])
})

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'native/windows-registry/src/addon.cc',
  'config/patches/node-pty.patch',
  '.github/actions/install-node-dependencies/action.yml',
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
  'src/main/wsl/runner.ts',
  'config/scripts/build-orcad-prebuilds.mjs',
  'config/scripts/orcad-prebuild-slot-contents.mjs',
  'src/shared/node-runtime-pin.ts'
])('retains all platforms for platform-flavoured input %s', (file) => {
  expect(nodeServerQualification([file], scope)).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
})

it('fails closed to every platform when the evidence is incomplete', () => {
  expect(nodeServerQualification([], scope).qualification).toBe(true)
  expect(
    nodeServerQualification(['src/main/runtime/rpc/methods/example.ts'], {
      ...scope,
      graphUnavailable: true
    }).qualification
  ).toBe(true)
})
