#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const sourcePaths = ['proc_info.c', 'proc_api_arguments.c'].map((name) =>
  path.join(repoRoot, 'native', 'proc-info-darwin', 'src', name)
)
export const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'proc-info-darwin',
  '.build',
  'release',
  'orca-proc-info.node'
)

if (process.platform !== 'darwin') {
  process.exit(0)
}

const args = process.argv.slice(2)
const outputPath = readArg('--output') ?? defaultOutputPath
const singleArch = args.includes('--single-arch')
const arches = singleArch ? [process.arch === 'arm64' ? 'arm64' : 'x86_64'] : ['arm64', 'x86_64']

mkdirSync(path.dirname(outputPath), { recursive: true })
execFileSync(
  'clang',
  [
    '-O2',
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-fvisibility=hidden',
    '-mmacosx-version-min=11.0',
    ...arches.flatMap((arch) => ['-arch', arch]),
    '-I',
    resolveNodeApiHeaders(),
    // N-API symbols come from Electron or Node at load time, so both load the same binary.
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    ...sourcePaths,
    '-o',
    outputPath
  ],
  { stdio: 'inherit' }
)

/** node_api.h ships with every Node install and in node-gyp's header cache. */
function resolveNodeApiHeaders() {
  const candidates = [
    path.join(path.dirname(process.execPath), '..', 'include', 'node'),
    path.join(homedir(), 'Library', 'Caches', 'node-gyp', process.versions.node, 'include', 'node')
  ]
  const found = candidates.find((candidate) => existsSync(path.join(candidate, 'node_api.h')))
  if (!found) {
    throw new Error(`node_api.h not found; looked in ${candidates.join(', ')}`)
  }
  return found
}

function readArg(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
