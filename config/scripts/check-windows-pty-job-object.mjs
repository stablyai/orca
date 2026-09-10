import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const WINDOWS_PTY_JOB_OBJECT_TESTS = [
  'src/main/providers/windows-pty-job-object.test.ts',
  'src/main/providers/local-pty-provider-shutdown.test.ts',
  'src/main/daemon/daemon-pty-adapter-protocol-compatibility.test.ts',
  'src/main/daemon/daemon-protocol-version.test.ts',
  'config/scripts/run-windows-pty-job-object-probe.test.ts',
  'config/scripts/check-windows-pty-job-object.test.ts'
]

export function runWindowsPtyJobObjectCheck(evidencePath, run = spawnSync) {
  const test = run('pnpm', ['exec', 'vitest', 'run', ...WINDOWS_PTY_JOB_OBJECT_TESTS], {
    cwd: process.cwd(),
    stdio: 'inherit'
  })
  if (test.status !== 0) {
    throw new Error('Focused Windows Job Object tests failed')
  }

  const probe = run(
    process.execPath,
    ['config/scripts/run-windows-pty-job-object-probe.mjs', '--evidence', evidencePath],
    { cwd: process.cwd(), stdio: 'inherit' }
  )
  if (probe.status !== 0) {
    throw new Error('Windows Job Object probe failed')
  }
}

function parseEvidencePath(argv) {
  const index = argv.indexOf('--evidence')
  if (index === -1 || !argv[index + 1]) {
    throw new Error('Usage: --evidence <path>')
  }
  return resolve(argv[index + 1])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runWindowsPtyJobObjectCheck(parseEvidencePath(process.argv.slice(2)))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
