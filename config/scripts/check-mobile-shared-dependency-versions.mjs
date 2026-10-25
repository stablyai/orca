#!/usr/bin/env node
// Root and mobile are separate pnpm projects, so nothing else stops their lockfiles drifting apart.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lockedVersion, lockfileRootImporter } from './pnpm-lockfile-root-importer.mjs'

// Shared tsconfig remaps to mobile copies; mismatched versions prevent TS merging Zod schemas, inferring {} (phone-feed-list.ts).
export const SHARED_DEPENDENCIES = ['zod', 'tweetnacl', '@noble/hashes', '@types/ws']

// Mobile typechecks through the root runner, whose Bun path accepts one TypeScript version, and
// mobile CI runs its tests with the root's Vitest CLI against mobile's `vitest` imports.
export const TOOLCHAIN_DEPENDENCIES = ['typescript', 'typescript-api', 'vitest']

const CHECKED_DEPENDENCIES = [...SHARED_DEPENDENCIES, ...TOOLCHAIN_DEPENDENCIES]

function importerVersion(importer, name) {
  return lockedVersion(importer.dependencies?.[name] ?? importer.devDependencies?.[name])
}

export function findSharedDependencyVersionProblems({
  rootImporter,
  mobileImporter,
  names = CHECKED_DEPENDENCIES
}) {
  const problems = []
  for (const name of names) {
    const root = importerVersion(rootImporter, name)
    const mobile = importerVersion(mobileImporter, name)
    if (!root || !mobile) {
      problems.push(`${name} is not a direct dependency of ${root ? 'mobile' : 'the root'}`)
    } else if (root !== mobile) {
      problems.push(`${name}: the root locks ${root}, mobile locks ${mobile}`)
    }
  }
  return problems
}

export function main(root = resolve(import.meta.dirname, '../..')) {
  const readImporter = (lockfile) =>
    lockfileRootImporter(readFileSync(join(root, lockfile), 'utf8'))
  const problems = findSharedDependencyVersionProblems({
    rootImporter: readImporter('pnpm-lock.yaml'),
    mobileImporter: readImporter(join('mobile', 'pnpm-lock.yaml'))
  })
  if (problems.length > 0) {
    console.error('Root and mobile must lock the same version of:')
    for (const problem of problems) {
      console.error(`- ${problem}`)
    }
    console.error(
      'Set the same range in package.json and mobile/package.json, then pnpm install in both.'
    )
    return 1
  }
  console.log(`Root and mobile lock the same ${CHECKED_DEPENDENCIES.join(', ')}.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
