import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isSharedPackageDir } from './native-build-entry.cjs'

// Find ancestor node_modules above global-store links root: upward Node resolution can inject undeclared dependencies and hide isolation bugs.
export function nodeModulesAboveStore(slotPackageDir, exists = existsSync) {
  let storeRoot = slotPackageDir
  while (basename(storeRoot) !== 'links') {
    const parent = dirname(storeRoot)
    if (parent === storeRoot) {
      return []
    }
    storeRoot = parent
  }
  const found = []
  for (let dir = dirname(storeRoot); ; dir = dirname(dir)) {
    if (exists(join(dir, 'node_modules'))) {
      found.push(join(dir, 'node_modules'))
    }
    if (dirname(dir) === dir) {
      return found
    }
  }
}

/** Warns, never fails: the install itself is fine, only undeclared-dependency checks are blinded. */
export function warnAboutNodeModulesAboveSharedStore(projectDir, probePackage = 'zod') {
  const linked = join(projectDir, 'node_modules', probePackage)
  if (!existsSync(linked) || !isSharedPackageDir(linked, projectDir)) {
    return []
  }
  const found = nodeModulesAboveStore(realpathSync(linked))
  for (const dir of found) {
    console.warn(
      `[gvs] ${dir} sits above the shared pnpm store, so packages there resolve dependencies ` +
        'they never declared and undeclared-dependency bugs stay hidden. Move or remove it.'
    )
  }
  return found
}
