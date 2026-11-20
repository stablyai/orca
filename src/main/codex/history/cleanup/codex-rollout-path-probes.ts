import { lstat, readlink, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'

/** Null when absent; undefined when it can't be told. */
export async function statUnlessAbsent(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

/** The entry itself, not a link's target. Null when absent; undefined when it can't be told. */
export async function lstatUnlessAbsent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

/** Whether a link points into a WSL distro, told from its text alone: touching it can start one. */
export async function linksIntoWsl(path: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }
  const target = await readlink(path).catch(() => null)
  if (target === null) {
    return false
  }
  // `\\?\UNC\host\share`, `\\.\UNC\…` and `//?/UNC/…` spell the same path as `\\host\share`.
  const plain = target
    .replace(/\//g, '\\')
    .replace(/^\\\\[?.]\\UNC\\/i, '\\\\')
    .replace(/^\\\\[?.]\\/, '')
  return parseWslUncPath(resolve(dirname(path), plain)) !== null
}

/** Whether a folder below a real root, or a folder it sits in, links into WSL; probes once each. */
export function createNestedWslLinkProbe(): (
  root: string,
  parts: readonly string[]
) => Promise<boolean> {
  const probes = new Map<string, Promise<boolean>>()
  return async (root, parts) => {
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = join(root, ...parts.slice(0, depth))
      const probe = probes.get(path) ?? linksIntoWsl(path)
      probes.set(path, probe)
      if (await probe) {
        return true
      }
    }
    return false
  }
}

/** Whether the path itself or any folder above it links into WSL, checked outermost first. */
export async function pathCrossesIntoWsl(path: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }
  const chain: string[] = []
  for (let current = path; dirname(current) !== current; current = dirname(current)) {
    chain.unshift(current)
  }
  for (const entry of chain) {
    if (await linksIntoWsl(entry)) {
      return true
    }
  }
  return false
}
