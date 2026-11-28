import { globSync } from 'node:fs'
import { defaultExclude } from 'vitest/config'

// Why one constant: the cross-version-wire job runs this directory, so a new file there runs with no list to update.
export const CROSS_VERSION_WIRE_DIR = 'tests/e2e/cross-version-wire/'

export const UNIT_INCLUDE = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'config/scripts/**/*.test.ts',
  'config/scripts/**/*.test.mjs',
  'tests/tools/**/*.test.mjs',
  'tests/e2e/**/*.unit.test.ts'
]

export const UNIT_SETUP_FILES = [
  'config/scripts/test-runtime/environment/vitest-real-agent-home-write-guard.ts',
  'config/scripts/test-runtime/environment/vitest-real-agent-cli-guard.ts',
  'config/scripts/test-runtime/environment/vitest-bun-node-builtins.ts',
  'config/scripts/test-runtime/dom/vitest-dom-setup.ts',
  'config/scripts/test-runtime/environment/vitest-host-ports-setup.ts',
  'config/scripts/test-runtime/environment/vitest-caller-identity-env-setup.ts',
  'config/scripts/test-runtime/environment/vitest-inherited-git-env-setup.ts',
  'config/scripts/test-runtime/environment/vitest-process-worker-setup.ts',
  'config/scripts/test-runtime/environment/vitest-orcad-feature-readiness-reset.ts'
]

export const UNIT_EXCLUDE = [...defaultExclude, `${CROSS_VERSION_WIRE_DIR}**`]

export function discoverUnitFiles(root = process.cwd()) {
  return globSync(UNIT_INCLUDE, { cwd: root, exclude: UNIT_EXCLUDE })
    .map((file) => file.replaceAll('\\', '/'))
    .sort()
}
