import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Resolve through existing parents before allowing owner-local credential output. */
export function outsideObserverSource(repoRoot: string, path: string): string {
  if (!isAbsolute(path)) {
    throw new Error('Use an absolute path')
  }
  const absolute = resolve(path)
  const root = realpathSync.native(repoRoot)
  // Requiring an existing parent avoids checking a lexical path that later resolves through a symlink.
  const parent = realpathSync.native(dirname(absolute))
  const target = existsSync(absolute)
    ? realpathSync.native(absolute)
    : join(parent, basename(absolute))
  const inRepo = relative(root, target)
  if (inRepo === '' || (inRepo !== '..' && !inRepo.startsWith(`..${sep}`) && !isAbsolute(inRepo))) {
    throw new Error('Credential files must be outside the source checkout')
  }
  return target
}

/** Keep bearer output separate from the durable ledger and its issue/revoke lock. */
export function assertObserverBearerOutputPath(userDataPath: string, outputPath: string): void {
  const ledger = join(userDataPath, 'observer-credentials.v1.json')
  if (outputPath === ledger || outputPath === `${ledger}.lock`) {
    throw new Error('Bearer output collides with observer credential store')
  }
}
