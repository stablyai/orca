// Load-and-spawn smoke for one built slot, under the PINNED Node rather than the build host's.
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import { findSlotProblems, readManifest } from './orcad-prebuild-slot-contents.mjs'
import { ensurePinnedNodeExecutable } from './pinned-node-downloads.mjs'
import { runProcessSync } from './script-child-process.mjs'

const require = createRequire(import.meta.url)

/**
 * Stages node-pty's JS with ONLY the slot's binaries in build/Release, the way orcad's installer
 * lays them out. No prebuilds/ directory is copied, so node-pty cannot fall back to upstream's.
 */
export function stageSmokeNodePty({ slotDir, stageDir }) {
  const sourceDir = dirname(require.resolve('node-pty/package.json'))
  const nodePtyDir = join(stageDir, 'node_modules', 'node-pty')
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(nodePtyDir, { recursive: true })
  cpSync(join(sourceDir, 'package.json'), join(nodePtyDir, 'package.json'))
  cpSync(join(sourceDir, 'lib'), join(nodePtyDir, 'lib'), { recursive: true })
  cpSync(slotDir, join(nodePtyDir, 'build', 'Release'), { recursive: true })
  const helper = join(nodePtyDir, 'build', 'Release', 'spawn-helper')
  if (existsSync(helper)) {
    chmodSync(helper, 0o755)
  }
  return nodePtyDir
}

export async function runOrcadPrebuildSmoke({ slot, prebuildsDir }) {
  const problems = findSlotProblems(readManifest(prebuildsDir), prebuildsDir, [slot])
  if (problems.length > 0) {
    throw new Error(`[orcad-prebuilds] cannot smoke ${slot}: ${problems.join('; ')}`)
  }
  const node = await ensurePinnedNodeExecutable({ target: slot })
  const nodePtyDir = stageSmokeNodePty({
    slotDir: join(prebuildsDir, slot),
    stageDir: join(prebuildsDir, '..', 'orcad-prebuild-smoke', slot)
  })
  const result = runProcessSync({
    program: node,
    args: [
      join(import.meta.dirname, 'orcad-prebuild-smoke-child.cjs'),
      nodePtyDir,
      NODE_RUNTIME_PIN.version
    ],
    timeoutMs: 60_000
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.code !== 0) {
    throw new Error(
      `[orcad-prebuilds] ${slot} smoke failed under pinned Node ${NODE_RUNTIME_PIN.version} (exit ${result.code}${result.timedOut ? ', timed out' : ''})`
    )
  }
  console.log(
    `[orcad-prebuilds] ${slot} loads and spawns under pinned Node ${NODE_RUNTIME_PIN.version}`
  )
}
