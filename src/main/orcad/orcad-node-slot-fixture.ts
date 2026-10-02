// Test fixture: a packaged Node slot whose runtime is the real pinned Node, laid out as shipped.
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type * as NodePty from 'node-pty'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_PTY_DIR,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../shared/orcad-artifacts'
import { detectNativeHostAbi, nativeSlotName } from './native-host-abi'

export function hostServerTarget(): ServerTarget {
  const slot = nativeSlotName(detectNativeHostAbi())
  const target = Object.keys(NODE_RUNTIME_ASSETS).find((candidate) => candidate === slot)
  if (!target) {
    throw new Error(`No pinned Node runtime for host slot ${slot}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: found among NODE_RUNTIME_ASSETS keys, which are ServerTargets.
  return target as ServerTarget
}

/** The pinned Node the runner (run-node-server-tests.mjs) or `build:orcad` provided, if any. */
export function locatePinnedNodeForTests(): string | null {
  const target = hostServerTarget()
  const candidates = [
    process.env.ORCA_PINNED_NODE,
    resolve(
      'out/orcad',
      ...orcadNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
    )
  ]
  return (
    candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate)) ??
    null
  )
}

/** The Bun the last Bun orcad shipped on; only the design D7 cross-runtime gates still run it. */
export const LAST_BUN_ORCAD_VERSION = '1.4.2'

/** Bun 1.4.2 (BUN_EXECUTABLE, else `bun` on PATH), the last runtime orcad shipped on, if any. */
export function locateBunForTests(): string | null {
  const candidate = process.env.BUN_EXECUTABLE ?? 'bun'
  try {
    const result = runProcessSync({ program: candidate, args: ['--version'], timeoutMs: 10_000 })
    return result.code === 0 && result.stdout.trim() === LAST_BUN_ORCAD_VERSION ? candidate : null
  } catch {
    return null
  }
}

/** Writes `<root>/slot/{.server-target,.runtime-node}` and links the runtime into `<root>/runtimes/`. */
export async function writeNodeSlotFixture(
  root: string,
  pinnedNode: string
): Promise<{ slotDir: string; runtime: string }> {
  const target = hostServerTarget()
  const { executableSha256 } = NODE_RUNTIME_ASSETS[target]
  const slotDir = join(root, 'slot')
  await mkdir(slotDir, { recursive: true })
  await writeFile(join(slotDir, ORCAD_SERVER_TARGET_FILENAME), `${target}\n`)
  await writeFile(join(slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), `${executableSha256}\n`)
  const runtime = join(slotDir, ...orcadNodeRuntimeRelativePath(target, executableSha256))
  await mkdir(join(runtime, '..'), { recursive: true })
  // Why a hard link: the runtime is ~120 MB, and a copy per test would dominate the suite.
  await link(pinnedNode, runtime).catch(() => copyFile(pinnedNode, runtime))
  return { slotDir, runtime }
}

/** Comma-separated input groups a lane must have; set by run-node-server-tests.mjs. */
export const ORCA_REQUIRED_TEST_INPUTS_ENV = 'ORCA_REQUIRED_TEST_INPUTS'
export type RequiredTestInputGroup = 'artifact' | 'cross-runtime'

function laneRequires(group: RequiredTestInputGroup): boolean {
  return (process.env[ORCA_REQUIRED_TEST_INPUTS_ENV] ?? '').split(',').includes(group)
}

/**
 * node-pty as orcad loads it: an artifact lane's packaged slot, else the dev install.
 * Why: server lanes install without building node-pty, and Linux has no upstream prebuild.
 */
export async function loadNodePtyForTests(): Promise<typeof NodePty> {
  if (!laneRequires('artifact')) {
    return import('node-pty')
  }
  const packaged = resolve('out/orcad', ORCAD_NODE_PTY_DIR)
  if (!existsSync(packaged)) {
    throw new Error(`Missing artifact test input: out/orcad/${ORCAD_NODE_PTY_DIR}`)
  }
  return createRequire(import.meta.url)(packaged)
}

/**
 * True when a suite must skip for `missing` inputs. A lane that named `group` as required
 * gets a failing test instead, so a missing input can never pass as a silent skip.
 */
export function skipForMissingInputs(
  group: RequiredTestInputGroup,
  missing: readonly string[]
): boolean {
  if (missing.length === 0) {
    return false
  }
  if (laneRequires(group)) {
    it(`has its required ${group} inputs`, () => {
      throw new Error(`Missing ${group} test inputs: ${missing.join('; ')}`)
    })
  }
  return true
}
