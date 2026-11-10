// Which commit a 4a arm's built app came from, proved from the checkout and its existing build output, never a product hook.
// The build already inlines `git rev-parse HEAD` as ORCA_BUILD_COMMIT (config/scripts/build-identity), which the renderer
// passes as the skills install `sourceCommit`; that literal is the artifact's own record of the commit it was built from.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Manifest } from './native-chat-4a-fixture'
import type { ArmResult } from './native-chat-4a-report'

const FULL_SHA = /^[0-9a-f]{40}$/
const BUILD_COMMIT_STAMP = /sourceCommit\s*:\s*["'`]([0-9a-f]{40})["'`]/g
const MAIN_BUNDLE = path.join('out', 'main', 'index.js')
const RENDERER_OUT = path.join('out', 'renderer')
// Inputs to `electron-vite build`; the harness itself (config/scripts/performance) is not product source.
const PRODUCT_SOURCES = [
  'src',
  'electron.vite.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'config/build-plugins',
  'config/dark-build-switches.cjs',
  'config/scripts/build-identity'
]

export type ArmSpec = { name: string; root: string; expectedSha: string }

export type ArmProvenance = {
  expectedSha: string
  /** Full checkout HEAD; equal to expectedSha or the arm was refused. */
  sha: string
  headCommittedAt: string
  productSources: string
  /** The commit the built renderer names; equal to sha or the arm was refused. */
  builtCommit: string
  stampFiles: string
  mainBundleSha256: string
  /** Oldest of the main bundle and stamped renderer files. */
  artifactBuiltAt: string
  newestSourceFile: string
  newestSourceModifiedAt: string
}

/** `name=<checkout>@<full sha>`: every arm names the exact commit it must run. */
export function parseArmSpec(spec: string): ArmSpec {
  const equals = spec.indexOf('=')
  const at = spec.lastIndexOf('@')
  const name = spec.slice(0, Math.max(0, equals))
  const root = spec.slice(equals + 1, at)
  const expectedSha = spec.slice(at + 1).toLowerCase()
  if (!name || equals === -1 || at <= equals || !FULL_SHA.test(expectedSha)) {
    throw new Error(`--arm takes name=<checkout>@<full 40-character sha>, got ${spec}`)
  }
  return { name, root, expectedSha }
}

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 })

function rendererScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return rendererScripts(file)
    }
    return entry.name.endsWith('.js') ? [file] : []
  })
}

/** Refuse an arm whose HEAD is not its pin, whose product sources are dirty, or whose build is not from that HEAD. */
export function verifyArmProvenance(spec: ArmSpec): ArmProvenance {
  const { name, root, expectedSha } = spec
  const refuse = (reason: string): never => {
    throw new Error(`${name}: ${root} ${reason}`)
  }
  const sha = git(root, 'rev-parse', 'HEAD').trim()
  if (sha !== expectedSha) {
    refuse(`is at ${sha}, not the pinned ${expectedSha}`)
  }
  const dirty = git(root, 'status', '--porcelain=v1', '--', ...PRODUCT_SOURCES)
    .split('\n')
    .filter(Boolean)
  if (dirty.length > 0) {
    refuse(`has uncommitted product sources: ${dirty.slice(0, 5).join('; ')}`)
  }
  if (!existsSync(path.join(root, MAIN_BUNDLE)) || !existsSync(path.join(root, RENDERER_OUT))) {
    refuse(`has no ${MAIN_BUNDLE} or ${RENDERER_OUT}; build that checkout first`)
  }
  const stamps = new Map<string, string[]>()
  for (const file of rendererScripts(path.join(root, RENDERER_OUT))) {
    for (const match of readFileSync(file, 'utf8').matchAll(BUILD_COMMIT_STAMP)) {
      stamps.set(match[1]!, [...(stamps.get(match[1]!) ?? []), path.relative(root, file)])
    }
  }
  if (stamps.size === 0) {
    refuse(`has a renderer build with no build-commit stamp; rebuild it from this checkout`)
  }
  if (stamps.size > 1 || !stamps.has(sha)) {
    refuse(`was built from ${[...stamps.keys()].join(', ')}, not HEAD ${sha}; rebuild it`)
  }
  const stampFiles = [...new Set(stamps.get(sha))]
  const artifacts = [MAIN_BUNDLE, ...stampFiles].map((file) => ({
    file,
    modifiedAt: statSync(path.join(root, file)).mtimeMs
  }))
  const oldestArtifact = Math.min(...artifacts.map((artifact) => artifact.modifiedAt))
  // A checkout or edit after the build rewrites a tracked file later than the output, whatever HEAD the stamp names.
  let newest = { file: '', modifiedAt: 0 }
  for (const file of git(root, 'ls-files', '-z', '--', ...PRODUCT_SOURCES).split('\0')) {
    const absolute = path.join(root, file)
    if (file && existsSync(absolute)) {
      const modifiedAt = statSync(absolute).mtimeMs
      newest = modifiedAt > newest.modifiedAt ? { file, modifiedAt } : newest
    }
  }
  if (newest.modifiedAt > oldestArtifact) {
    refuse(`has ${newest.file} modified after its build output; rebuild it`)
  }
  return {
    expectedSha,
    sha,
    headCommittedAt: git(root, 'show', '-s', '--format=%cI', sha).trim(),
    productSources: PRODUCT_SOURCES.join(' '),
    builtCommit: sha,
    stampFiles: stampFiles.join(' '),
    mainBundleSha256: createHash('sha256')
      .update(readFileSync(path.join(root, MAIN_BUNDLE)))
      .digest('hex'),
    artifactBuiltAt: new Date(oldestArtifact).toISOString(),
    newestSourceFile: newest.file,
    newestSourceModifiedAt: new Date(newest.modifiedAt).toISOString()
  }
}

/** One run only: one result per arm, each from its pin, all on one seed and recipe; anything else is refused. */
export function assertOneRun(results: ArmResult[], pins: readonly ArmSpec[]): void {
  const refuse = (reason: string): never => {
    throw new Error(`report-only: ${reason}; re-run into a fresh --out instead of mixing arms`)
  }
  for (const result of results) {
    const p: Partial<ArmResult['provenance']> = result.provenance ?? {}
    if (p.expectedSha !== result.sha || p.builtCommit !== result.sha) {
      refuse(`${result.arm} ${result.sha} carries no pin and build provenance matching its sha`)
    }
  }
  const names = results.map((result) => result.arm)
  if (new Set(names).size !== names.length) {
    refuse(`more than one result for an arm (${names.join(', ')})`)
  }
  for (const field of ['seedSha', 'recipe', 'largeSourceRecipe']) {
    const seen = new Set(results.map((result) => String(result.fixture[field])))
    if (seen.size !== 1 || seen.has('undefined')) {
      refuse(`arms disagree on or lack fixture ${field} (${[...seen].join(', ')})`)
    }
  }
  for (const pin of pins) {
    const result = results.find((each) => each.arm === pin.name)
    if (result?.sha !== pin.expectedSha) {
      refuse(`${pin.name} is ${result?.sha ?? 'missing'}, not the pinned ${pin.expectedSha}`)
    }
  }
  if (pins.length > 0 && results.length !== pins.length) {
    refuse(`found arms ${names.join(', ')}, pinned ${pins.map((pin) => pin.name).join(', ')}`)
  }
}

/** A cached seed is reused by recipe alone, so one written by another commit of the seed arm is refused. */
export function seededBy(arm: { name: string; sha: string }, seeded: Manifest): Manifest {
  if (seeded.seedSha !== arm.sha) {
    throw new Error(
      `a cached seed was written by ${seeded.seedSha}, not ${arm.name} ${arm.sha}; use a fresh --out`
    )
  }
  return seeded
}
