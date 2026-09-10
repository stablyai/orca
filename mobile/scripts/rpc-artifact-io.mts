import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { runProcess } from '../../src/shared/child-process/run-process.ts'
export const root = resolve(import.meta.dirname, '../..')
export function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? files(path) : [relative(root, path).split('\\').join('/')]
    })
    .sort()
}
export function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing --${name}`)
  }
  return value
}
export async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: root, maxOutputBytes: 8_000_000 })
  if (result.code !== 0 || result.outputTruncated) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }
  return result.stdout.trimEnd()
}
export function emit(name: string, value: unknown): void {
  const path = resolve(root, option('output', `mobile/rpc-foundation/${name}.json`))
  if (process.argv.includes('--check')) {
    if (!isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), value)) {
      throw new Error(`Stale artifact: ${path}`)
    }
    console.log(`${name}: current`)
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
    console.log(`${name}: ${path}`)
  }
}
