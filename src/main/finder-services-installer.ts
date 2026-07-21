import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type FinderServicesInstallResult = {
  installed: number
  skipped: boolean
}

type InstallFinderServicesOptions = {
  platform?: NodeJS.Platform
  sourceRoot: string
  homePath?: string
}

export async function installFinderServices({
  platform = process.platform,
  sourceRoot,
  homePath = homedir()
}: InstallFinderServicesOptions): Promise<FinderServicesInstallResult> {
  if (platform !== 'darwin') {
    return { installed: 0, skipped: true }
  }
  let sourceServices: string[]
  try {
    sourceServices = await listFinderServiceBundles(sourceRoot)
  } catch {
    throw new Error(`finder_services_bundle_missing:${sourceRoot}`)
  }
  if (sourceServices.length === 0) {
    throw new Error(`finder_services_bundle_missing:${sourceRoot}`)
  }

  const targetRoot = join(homePath, 'Library', 'Services')
  await mkdir(targetRoot, { recursive: true })

  let installed = 0
  for (const serviceName of sourceServices) {
    const sourcePath = join(sourceRoot, serviceName)
    const targetPath = join(targetRoot, serviceName)
    const alreadyCurrent = await directoriesHaveSameFiles(sourcePath, targetPath).catch(() => false)
    if (alreadyCurrent) {
      continue
    }
    await rm(targetPath, { recursive: true, force: true })
    await cp(sourcePath, targetPath, { recursive: true, force: true })
    installed += 1
  }
  return { installed, skipped: false }
}

async function listFinderServiceBundles(sourceRoot: string): Promise<string[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.workflow'))
    .map((entry) => entry.name)
    .sort()
}

async function directoriesHaveSameFiles(leftRoot: string, rightRoot: string): Promise<boolean> {
  const leftFiles = await listRelativeFiles(leftRoot)
  const rightFiles = await listRelativeFiles(rightRoot)
  if (leftFiles.length !== rightFiles.length) {
    return false
  }
  for (let i = 0; i < leftFiles.length; i += 1) {
    const relativePath = leftFiles[i]
    if (relativePath !== rightFiles[i]) {
      return false
    }
    const [left, right] = await Promise.all([
      readFile(join(leftRoot, relativePath)),
      readFile(join(rightRoot, relativePath))
    ])
    if (!left.equals(right)) {
      return false
    }
  }
  return true
}

async function listRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, relativePath)))
    } else if (entry.isFile()) {
      files.push(relativePath)
    } else {
      const entryStat = await stat(join(root, relativePath)).catch(() => null)
      if (entryStat?.isFile()) {
        files.push(relativePath)
      }
    }
  }
  return files.sort()
}
