import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const Package = z.object({ name: z.literal('@openai/codex') })

export async function codexNpmInstallationFiles(
  packagePaths: readonly string[]
): Promise<string[]> {
  const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null
  const system =
    process.platform === 'darwin'
      ? 'apple-darwin'
      : process.platform === 'win32'
        ? 'pc-windows-msvc'
        : 'unknown-linux-musl'
  if (!cpu) {
    return []
  }
  const triple = `${cpu}-${system}`
  const files: string[] = []
  for (const file of packagePaths) {
    try {
      if (!Package.safeParse(JSON.parse(await readFile(file, 'utf8'))).success) {
        continue
      }
      const root = dirname(file)
      const platformPackage = `@openai/codex-${process.platform}-${process.arch}/package.json`
      let nativePackage: string | undefined
      try {
        nativePackage = createRequire(file).resolve(platformPackage)
      } catch {
        /* Older packages bundle their own vendor directory. */
      }
      const roots = [
        join(root, 'vendor'),
        ...(nativePackage ? [join(dirname(nativePackage), 'vendor')] : [])
      ]
      if (nativePackage) {
        files.push(nativePackage)
      }
      for (const vendor of roots) {
        for (const directory of ['bin', 'codex']) {
          files.push(
            join(vendor, triple, directory, process.platform === 'win32' ? 'codex.exe' : 'codex')
          )
        }
      }
    } catch {
      // Unreadable package metadata cannot establish a launcher shape.
    }
  }
  return files
}
