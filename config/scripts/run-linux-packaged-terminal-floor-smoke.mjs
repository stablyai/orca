import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PACKAGES =
  'ca-certificates libasound2 libatspi2.0-0 libdrm2 libgbm1 libgtk-3-0 libnss3 libx11-xcb1 libxkbcommon0 libxss1'
const CHILD = `require(process.argv[1]).qualifyPackagedTerminal(process.argv[2]).then(report => console.log(JSON.stringify(report)), error => { console.error(error); process.exitCode = 1 })`

export async function buildPackagedTerminalFloorFixture(outputDirectory) {
  const outfile = join(outputDirectory, 'packaged-terminal-floor.cjs')
  await build({
    entryPoints: [join(ROOT, 'src/main/daemon/linux-packaged-terminal-floor-fixture.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'silent'
  })
  return outfile
}

export function packagedTerminalFloorDockerArgs({ appDirectory, fixtureDirectory, containerName }) {
  for (const path of [appDirectory, fixtureDirectory]) {
    if (path.includes(',')) {
      throw new Error('Docker bind paths must not contain commas')
    }
  }
  return [
    'run',
    '--rm',
    ...(containerName ? ['--name', containerName] : []),
    '--network',
    'bridge',
    '--mount',
    `type=bind,src=${resolve(appDirectory)},dst=/artifact,readonly`,
    '--mount',
    `type=bind,src=${resolve(fixtureDirectory)},dst=/qualification,readonly`,
    '--env',
    'ORCA_BACKGROUND_LAUNCH=1',
    '--env',
    'ELECTRON_RUN_AS_NODE=1',
    'ubuntu:20.04',
    '/bin/bash',
    '-ec',
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq ${PACKAGES} >/dev/null; exec /artifact/orca-ide -e "$1" /qualification/packaged-terminal-floor.cjs /artifact/resources`,
    'terminal-floor',
    CHILD
  ]
}

export async function runPackagedTerminalFloorSmoke(appDirectory) {
  if (process.platform !== 'linux') {
    throw new Error('Packaged Linux floor smoke requires Linux')
  }
  const app = resolve(appDirectory)
  for (const path of [
    'orca-ide',
    'resources/cli-runtime/bun-runtime',
    'resources/terminal-daemon/daemon-entry.js'
  ]) {
    if (!existsSync(join(app, path))) {
      throw new Error(`Missing packaged artifact: ${join(app, path)}`)
    }
  }
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'orca-terminal-floor-runner-'))
  try {
    const fixture = await buildPackagedTerminalFloorFixture(fixtureDirectory)
    const { runProcess } = createRequire(import.meta.url)(fixture)
    const containerName = `orca-terminal-floor-${randomUUID()}`
    let result
    let cleanup
    try {
      result = await runProcess({
        program: 'docker',
        args: packagedTerminalFloorDockerArgs({
          appDirectory: app,
          fixtureDirectory,
          containerName
        }),
        timeoutMs: 300_000,
        maxOutputBytes: 8 * 1024 * 1024
      })
    } finally {
      // A terminated Docker client does not stop its container.
      cleanup = await runProcess({
        program: 'docker',
        args: ['rm', '--force', containerName],
        timeoutMs: 10_000,
        maxOutputBytes: 8192
      })
    }
    if (cleanup.timedOut || (cleanup.code !== 0 && !cleanup.stderr.includes('No such container'))) {
      throw new Error(
        `Could not remove qualification container ${containerName}: ${cleanup.stderr}`
      )
    }
    if (result.timedOut || result.outputTruncated || result.code !== 0) {
      throw new Error(
        `Packaged terminal floor smoke failed: ${result.stderr || `exit=${result.code} timeout=${result.timedOut}`}`
      )
    }
    process.stdout.write(result.stdout)
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--app-dir' || !process.argv[3]) {
    throw new Error('Usage: run-linux-packaged-terminal-floor-smoke.mjs --app-dir <packaged-app>')
  }
  await runPackagedTerminalFloorSmoke(process.argv[3])
}
