import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildLifecycleExtensionSource } from './extension-source'
import type { LifecycleExtension, WorkspaceRuntimeDescriptor } from './extension-types'

async function verifyCacheDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Lifecycle extension cache directory is not a regular directory')
  }
  const getuid = process.getuid
  if (getuid && stat.uid !== getuid()) {
    throw new Error('Lifecycle extension cache directory has the wrong owner')
  }
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
    throw new Error('Lifecycle extension cache directory is writable by another principal')
  }
}

async function verifyExisting(path: string, source: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Lifecycle extension cache entry is not a single-link regular file')
  }
  if ((await readFile(path, 'utf8')) !== source) {
    throw new Error('Lifecycle extension cache content does not match its address')
  }
}

async function writeContentAddressedFile(path: string, source: string): Promise<void> {
  try {
    await writeFile(path, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    await verifyExisting(path, source)
  }
}

function runtimeModuleSuffix(): '.ts' | '.js' {
  return __filename.endsWith('.ts') ? '.ts' : '.js'
}

async function materializeWorkspaceRuntime(root: string): Promise<WorkspaceRuntimeDescriptor> {
  const suffix = runtimeModuleSuffix()
  const modules = await Promise.all(
    ['workspace-security-runtime', 'workspace-mutation-runtime'].map(async (name) => ({
      name,
      source: await readFile(join(__dirname, `${name}${suffix}`), 'utf8')
    }))
  )
  const sourceHash = createHash('sha256')
    .update(modules.map(({ name, source }) => `${name}\0${source}`).join('\0'))
    .digest('hex')
  const directory = join(root, `workspace-${sourceHash}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await verifyCacheDirectory(directory)
  const paths = new Map<string, string>()
  for (const module of modules) {
    const path = join(directory, `${module.name}${suffix}`)
    await writeContentAddressedFile(path, module.source)
    paths.set(module.name, pathToFileURL(path).href)
  }
  return {
    sourceHash,
    securitySource: paths.get('workspace-security-runtime')!,
    mutationSource: paths.get('workspace-mutation-runtime')!
  }
}

export async function materializeLifecycleExtension(
  nonce: string,
  root = join(tmpdir(), 'orca-pi-rpc-worker-v2')
): Promise<LifecycleExtension> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await verifyCacheDirectory(root)
  const workspaceRuntime = await materializeWorkspaceRuntime(root)
  const source = buildLifecycleExtensionSource(nonce, workspaceRuntime)
  const sourceHash = createHash('sha256').update(source).digest('hex')
  const path = join(root, `lifecycle-${sourceHash}.ts`)
  await writeContentAddressedFile(path, source)
  return {
    source,
    sourceHash,
    path,
    selectedSource: pathToFileURL(path).href,
    workspaceRuntime
  }
}
