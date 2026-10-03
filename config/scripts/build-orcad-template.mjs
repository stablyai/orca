#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  ORCAD_NODE_PTY_DIR,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadNodePtySlotFiles,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { orcadAgentBrowserNativeName } from '../../src/shared/orcad-agent-browser-name.ts'
import {
  COMPAT_SERVER_TARGET_BASES,
  COMPAT_SERVER_TARGETS,
  ORCAD_TEMPLATE_TARGETS,
  pinnedNodeRuntimeAsset
} from '../../src/shared/node-runtime-pin.ts'
import { ORCAD_PREBUILDS_DIR } from './build-orcad-prebuilds.mjs'
import { findSlotProblems, readManifest } from './orcad-prebuild-slot-contents.mjs'
import { runProcessSync } from './script-child-process.mjs'
import { verifyPackagedOrcadTemplate } from './verify-packaged-orcad-template.cjs'

const root = resolve(import.meta.dirname, '../..')
const outputDir = join(root, 'out', 'orcad-template')
const buildDir = join(root, 'out', '.orcad-template-build')
const commonArtifacts = orcadTemplateCommonFilenames()

function isExecutable(filename) {
  return /(?:^|\/)(?:rg|spawn-helper)$/.test(filename)
}

function copy(source, destination, executable = false) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  if (executable && process.platform !== 'win32') {
    chmodSync(destination, 0o755)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** One full package per target; each needs that target's node-pty slot in out/orcad-prebuilds. */
function buildTargetPackage(target) {
  const packageDir = join(buildDir, target, 'orcad')
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-orcad-node.mjs'),
      '--target',
      target,
      '--out-dir',
      packageDir
    ],
    cwd: root,
    // Why no agent-browser: the template ships inside every desktop build (design D2), and seven
    // ~10 MB browsers would outweigh everything else in it; a slot without one reports no browser.
    env: { ...process.env, ORCAD_OMIT_AGENT_BROWSER: '1' },
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`orcad ${target} package build failed with exit ${result.code ?? 'unknown'}`)
  }
  return packageDir
}

function stageTarget(target, packageDir) {
  const destination = join(outputDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const files = {}
  for (const filename of orcadTemplateTargetFilenames(target)) {
    const staged = join(destination, ...filename.split('/'))
    copy(join(packageDir, ...filename.split('/')), staged, isExecutable(filename))
    files[filename] = sha256(staged)
  }
  const browserName = orcadAgentBrowserNativeName(
    target.split('-')[0],
    target.split('-')[1],
    target.endsWith('-musl') ? 'musl' : 'glibc'
  )
  const browserSource = join(packageDir, browserName)
  if (!existsSync(browserSource)) {
    return { files }
  }
  const browserDestination = join(destination, browserName)
  copy(browserSource, browserDestination, true)
  return { files, browserName, browserSha256: sha256(browserDestination) }
}

/**
 * `--targets a,b` builds a partial template for CI jobs that can fill only some prebuild slots
 * (the SSH hostile-host matrix). A shipped template always carries every target.
 */
export function requestedTemplateTargets(argv = process.argv) {
  const index = argv.indexOf('--targets')
  if (index === -1) {
    return ORCAD_TEMPLATE_TARGETS
  }
  const targets = (argv[index + 1] ?? '').split(',').filter(Boolean)
  const unknown = targets.filter((target) => !ORCAD_TEMPLATE_TARGETS.includes(target))
  if (targets.length === 0 || unknown.length > 0) {
    throw new Error(
      `--targets needs a comma-separated subset of ${ORCAD_TEMPLATE_TARGETS.join(',')}; got ${argv[index + 1] ?? 'nothing'}`
    )
  }
  return [...new Set(targets)]
}

/**
 * A compat target (design D6 rung B) is its base target's package with the compat node-pty
 * slot and runtime marker swapped in; everything else is target-independent or libc-static.
 * Omitted, not failed, when this build has no compat slot: rung B then refuses as unavailable.
 */
function stageCompatTarget(compat, basePackageDir) {
  const problems = findSlotProblems(readManifest(ORCAD_PREBUILDS_DIR), ORCAD_PREBUILDS_DIR, [
    compat
  ])
  if (problems.length > 0) {
    process.stdout.write(
      `[build-orcad-template] skipping compat target ${compat}: ${problems.join('; ')}\n`
    )
    return null
  }
  const destination = join(outputDir, ORCAD_TEMPLATE_TARGETS_DIR, compat)
  const slotFiles = new Map(
    orcadNodePtySlotFiles(compat).map((file) => [
      `${ORCAD_NODE_PTY_DIR}/build/Release/${file}`,
      join(ORCAD_PREBUILDS_DIR, compat, ...file.split('/'))
    ])
  )
  const files = {}
  for (const filename of orcadTemplateTargetFilenames(compat)) {
    const staged = join(destination, ...filename.split('/'))
    if (filename === ORCAD_SERVER_TARGET_FILENAME) {
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, `${compat}\n`)
    } else if (filename === ORCAD_NODE_RUNTIME_MARKER_FILENAME) {
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, `${pinnedNodeRuntimeAsset(compat).executableSha256}\n`)
    } else {
      const source = slotFiles.get(filename) ?? join(basePackageDir, ...filename.split('/'))
      copy(source, staged, isExecutable(filename))
    }
    files[filename] = sha256(staged)
  }
  return { files }
}

function sameBytes(left, right) {
  return sha256(left) === sha256(right)
}

async function main() {
  const templateTargets = requestedTemplateTargets()
  rmSync(buildDir, { recursive: true, force: true })
  const packages = Object.fromEntries(
    templateTargets.map((target) => [target, buildTargetPackage(target)])
  )
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  const [firstTarget] = templateTargets
  for (const filename of commonArtifacts) {
    const source = join(packages[firstTarget], ...filename.split('/'))
    // Why check every target: the template keeps one copy, so a per-target difference would ship wrong bytes.
    for (const target of templateTargets) {
      if (!sameBytes(source, join(packages[target], ...filename.split('/')))) {
        throw new Error(`${filename} differs between ${firstTarget} and ${target} packages`)
      }
    }
    copy(source, join(outputDir, ...filename.split('/')), isExecutable(filename))
  }
  const targets = Object.fromEntries(
    templateTargets.map((target) => [target, stageTarget(target, packages[target])])
  )
  // A partial CI template stages a compat target only beside its base target.
  for (const compat of COMPAT_SERVER_TARGETS.filter((candidate) =>
    templateTargets.includes(COMPAT_SERVER_TARGET_BASES[candidate])
  )) {
    const staged = stageCompatTarget(compat, packages[COMPAT_SERVER_TARGET_BASES[compat]])
    if (staged) {
      targets[compat] = staged
    }
  }
  const commonSha256 = Object.fromEntries(
    commonArtifacts.map((filename) => [filename, sha256(join(outputDir, filename))])
  )
  writeFileSync(
    join(outputDir, ORCAD_TEMPLATE_MANIFEST_FILENAME),
    `${JSON.stringify({ schemaVersion: 3, commonSha256, targets }, null, 2)}\n`
  )
  verifyPackagedOrcadTemplate(join(root, 'out'), templateTargets)
  rmSync(buildDir, { recursive: true, force: true })
  process.stdout.write(`[build-orcad-template] ok — ${Object.keys(targets).length} targets\n`)
}

if (process.argv[1]?.endsWith('build-orcad-template.mjs')) {
  await main()
}
