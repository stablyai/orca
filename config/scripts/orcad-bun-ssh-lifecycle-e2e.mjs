#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { readOrcadBunSshTestFile } from './orcad-bun-ssh-test-file.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const image = 'orca-orcad-ssh-lifecycle:e2e'
const fixture = join(root, 'tests', 'e2e', 'fixtures', 'docker-ssh-relay')
const artifactDir =
  process.env.ORCA_REVIEW_ORCAD_ARTIFACT_DIR ?? join(root, 'out', 'orcad-ssh-lifecycle')
const lifecycleTest = readOrcadBunSshTestFile(
  process.argv.slice(2),
  'tests/e2e/orcad-remote-lifecycle.docker.unit.test.ts'
)

function run(program, args, options = {}) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    timeoutMs: null,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    ...options
  })
  if (result.code !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exit(result.code ?? 1)
  }
  return result.stdout.trim()
}

const dockerArch = run('docker', ['version', '--format', '{{.Server.Arch}}'])
const targetArch =
  dockerArch === 'arm64' || dockerArch === 'aarch64'
    ? 'arm64'
    : dockerArch === 'amd64' || dockerArch === 'x86_64'
      ? 'x64'
      : null
if (!targetArch) {
  throw new Error(`Unsupported Docker architecture: ${dockerArch}`)
}
const bunTarget = `linux-${targetArch}-glibc`

if (
  resolve(root, lifecycleTest) ===
  join(root, 'tests', 'e2e', 'orcad-live-catalog-migration.docker.unit.test.ts')
) {
  run(process.execPath, [join(root, 'config', 'scripts', 'build-relay.mjs')], {
    stdio: 'inherit'
  })
}

run(
  'docker',
  [
    'build',
    '--tag',
    image,
    '--build-arg',
    'SSH_BASE_IMAGE=debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171',
    '--file',
    join(fixture, 'Dockerfile'),
    fixture
  ],
  {
    stdio: 'inherit'
  }
)
run(
  process.execPath,
  [
    join(root, 'config', 'scripts', 'build-orcad-bun.mjs'),
    '--target',
    bunTarget,
    '--out-dir',
    artifactDir
  ],
  { stdio: 'inherit' }
)
run(
  pnpm,
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'config/vitest.config.ts',
    lifecycleTest,
    '--maxWorkers=1',
    '--reporter=verbose'
  ],
  {
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_SSH_DOCKER_IMAGE: image,
      ORCA_REVIEW_ORCAD_ARTIFACT_DIR: artifactDir,
      ORCA_REVIEW_ORCAD_SSH_LIFECYCLE: '1',
      ORCA_REVIEW_ORCAD_TARGET: bunTarget,
      ORCA_REVIEW_ORCAD_NO_HOST_NODE: '1'
    },
    stdio: 'inherit'
  }
)
