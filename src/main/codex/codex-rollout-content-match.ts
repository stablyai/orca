import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'

/** Existing copies must match the verified source before they can be resumed. */
export function codexRolloutContentMatches(sourcePath: string, targetPath: string): boolean {
  const descriptors: number[] = []
  try {
    if (!lstatSync(targetPath).isFile()) {
      return false
    }
    const source = openSync(sourcePath, 'r')
    descriptors.push(source)
    const target = openSync(targetPath, 'r')
    descriptors.push(target)
    const sourceStat = fstatSync(source)
    const targetStat = fstatSync(target)
    if (!sourceStat.isFile() || sourceStat.size === 0) {
      return false
    }
    if (
      sourceStat.ino !== 0 &&
      sourceStat.dev === targetStat.dev &&
      sourceStat.ino === targetStat.ino
    ) {
      return true
    }
    if (sourceStat.size !== targetStat.size) {
      return false
    }
    const left = Buffer.alloc(64 * 1024)
    const right = Buffer.alloc(left.length)
    for (let offset = 0; offset < sourceStat.size;) {
      const length = Math.min(left.length, sourceStat.size - offset)
      const count = readSync(source, left, 0, length, offset)
      if (count !== length || readSync(target, right, 0, length, offset) !== length) {
        return false
      }
      if (!left.subarray(0, length).equals(right.subarray(0, length))) {
        return false
      }
      offset += length
    }
    return fstatSync(source).size === sourceStat.size && fstatSync(target).size === targetStat.size
  } catch {
    return false
  } finally {
    for (const descriptor of descriptors) {
      closeSync(descriptor)
    }
  }
}
