import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type * as NodePty from 'node-pty'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import {
  NODE_RUNTIME_ASSETS,
  SERVER_TARGETS,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_PTY_DIR,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../shared/orcad-artifacts'
import { detectNativeHostAbi, nativeSlotName } from './native-host-abi'

export function hostServerTarget(): ServerTarget {
  const slot = nativeSlotName(detectNativeHostAbi())
  const target = SERVER_TARGETS.find((candidate) => candidate === slot)
  if (!target) {
    throw new Error(`No pinned Node runtime for host slot ${slot}`)
  }
  return target
}

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

const crossRuntimeBunVersion = readFileSync(
  new URL('../../../config/.bun-version', import.meta.url),
  'utf8'
).trim()

export function locateBunForTests(): string | null {
  const candidate = process.env.BUN_EXECUTABLE ?? 'bun'
  try {
    const result = runProcessSync({ program: candidate, args: ['--version'], timeoutMs: 10_000 })
    return result.code === 0 && result.stdout.trim() === crossRuntimeBunVersion ? candidate : null
  } catch {
    return null
  }
}

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
  // Hard-link the ~120 MB runtime to avoid a copy per test.
  await link(pinnedNode, runtime).catch(() => copyFile(pinnedNode, runtime))
  return { slotDir, runtime }
}

export function installPackagedOrcadSlotForTests(
  root: string,
  pinnedNode: string,
  sourceDir = resolve('out/orcad')
): { slotDir: string; runtime: string } {
  const linkOrCopy = (from: string, to: string): void => {
    try {
      linkSync(from, to)
    } catch {
      copyFileSync(from, to)
    }
  }
  const installTree = (source: string, destination: string): void => {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        installTree(join(source, entry.name), join(destination, entry.name))
      } else {
        linkOrCopy(join(source, entry.name), join(destination, entry.name))
      }
    }
  }
  const slotDir = join(root, 'orcad-test')
  installTree(sourceDir, slotDir)
  const target = hostServerTarget()
  const runtime = resolve(
    slotDir,
    ...orcadNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
  )
  mkdirSync(join(runtime, '..'), { recursive: true })
  linkOrCopy(pinnedNode, runtime)
  return { slotDir, runtime }
}

export const ORCA_REQUIRED_TEST_INPUTS_ENV = 'ORCA_REQUIRED_TEST_INPUTS'
export type RequiredTestInputGroup = 'artifact' | 'cross-runtime'

function laneRequires(group: RequiredTestInputGroup): boolean {
  return (process.env[ORCA_REQUIRED_TEST_INPUTS_ENV] ?? '').split(',').includes(group)
}

/** Server lanes skip native builds; load node-pty from their qualified slot. */
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

/** Required CI inputs fail instead of silently skipping when absent. */
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
