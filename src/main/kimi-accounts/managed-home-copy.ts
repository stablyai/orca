import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_IMPORT_ENTRIES = 1_024
const MAX_IMPORT_BYTES = 32 * 1024 * 1024

type CopyBudget = {
  entries: number
  bytes: number
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function secureMode(path: string, kind: 'file' | 'directory'): void {
  if (process.platform === 'win32') {
    return
  }
  chmodSync(path, kind === 'file' ? 0o600 : 0o700)
}

function copyTree(
  source: string,
  destination: string,
  sourceRoot: string,
  budget: CopyBudget
): void {
  const info = lstatSync(source)
  if (info.isSymbolicLink()) {
    throw new Error(`Kimi account import does not accept symbolic links: ${basename(source)}`)
  }
  budget.entries += 1
  if (budget.entries > MAX_IMPORT_ENTRIES) {
    throw new Error('Kimi account import contains too many files.')
  }
  const canonicalSource = realpathSync(source)
  if (!isInside(sourceRoot, canonicalSource)) {
    throw new Error('Kimi account import escapes the selected home.')
  }
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: false, mode: 0o700 })
    secureMode(destination, 'directory')
    for (const entry of readdirSync(source)) {
      copyTree(join(source, entry), join(destination, entry), sourceRoot, budget)
    }
    return
  }
  if (!info.isFile()) {
    throw new Error(`Kimi account import accepts only regular files: ${basename(source)}`)
  }
  budget.bytes += statSync(source).size
  if (budget.bytes > MAX_IMPORT_BYTES) {
    throw new Error('Kimi account import exceeds the 32 MB safety limit.')
  }
  copyFileSync(source, destination)
  secureMode(destination, 'file')
}

export function copyKimiCredentialScope(sourceHome: string, destinationHome: string): void {
  const resolvedSource = resolve(sourceHome)
  if (!existsSync(resolvedSource) || !lstatSync(resolvedSource).isDirectory()) {
    throw new Error('Selected Kimi home does not exist or is not a directory.')
  }
  const sourceRoot = realpathSync(resolvedSource)
  mkdirSync(destinationHome, { recursive: true, mode: 0o700 })
  secureMode(destinationHome, 'directory')
  const budget: CopyBudget = { entries: 0, bytes: 0 }
  let copied = false
  for (const name of ['config.toml', 'credentials']) {
    const source = join(sourceRoot, name)
    if (!existsSync(source)) {
      continue
    }
    copyTree(source, join(destinationHome, name), sourceRoot, budget)
    copied = true
  }
  if (!copied) {
    throw new Error('Selected Kimi home has no config.toml or credentials directory.')
  }
}
