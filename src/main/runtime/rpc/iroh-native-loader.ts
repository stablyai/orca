import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Endpoint, RelayMode } from '@number0/iroh'
import { detectNativeHostAbi, type NativeHostAbi } from '../../orcad/native-host-abi'

export type IrohNativeModule = {
  Endpoint: typeof Endpoint
  RelayMode: typeof RelayMode
  Accepting: { incomingHandshakeTimeoutMs: () => number }
}

const requireFromHere = createRequire(__filename)
const SOURCE_NATIVE_MAIN = /^(?:\.\/)?native-[a-f0-9]{64}\.node$/

type IrohHost = Pick<NativeHostAbi, 'platform' | 'arch' | 'libc'>

/** Only the seven produced SDK slots may select a native; never substitute another ABI. */
function nativeFilename({ platform, arch, libc }: IrohHost): string {
  if (
    (arch !== 'x64' && arch !== 'arm64') ||
    (platform === 'darwin' && arch !== 'arm64') ||
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    (platform === 'linux' && libc !== 'glibc' && libc !== 'musl') ||
    (platform !== 'linux' && libc !== 'none')
  ) {
    throw new Error('Unsupported Iroh native target')
  }
  const suffix =
    platform === 'linux'
      ? libc === 'musl'
        ? '-musl'
        : '-gnu'
      : platform === 'win32'
        ? '-msvc'
        : ''
  return `iroh.${platform}-${arch}${suffix}.node`
}

/** Match emitted CLI, electron-vite main/chunks, and flat daemon layouts, not ancestor packages. */
function sdkRoots(
  moduleFilename: string,
  resourcesPath: string | undefined
): {
  roots: string[]
  source: boolean
} {
  let directory = dirname(moduleFilename)
  const tree = join(directory, '..', '..', '..')
  if (
    directory.endsWith(`${sep}main${sep}runtime${sep}rpc`) &&
    (basename(tree) === 'src' || basename(tree) === 'out')
  ) {
    return { roots: [join(tree, '..', 'out')], source: true }
  }
  if (
    basename(directory) === 'chunks' &&
    basename(dirname(directory)) === 'main' &&
    basename(join(directory, '..', '..')) === 'out'
  ) {
    directory = dirname(directory)
  }
  if (basename(directory) === 'main' && basename(dirname(directory)) === 'out') {
    return {
      roots: resourcesPath ? [resourcesPath, dirname(directory)] : [dirname(directory)],
      source: false
    }
  }
  return { roots: [directory], source: false }
}

/** Resolve symlinks before loading: neither package links nor native links may escape the app. */
function confinedPath(path: string, root: string): string {
  const real = realpathSync(path)
  const fromRoot = relative(realpathSync(root), real)
  if (
    fromRoot === '' ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot === '..' ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('Iroh native is outside the application')
  }
  return real
}

/** Select only staged native files. SDK JavaScript, Node's package search, and NAPI/WASI overrides never run. */
export function resolveIrohNativePath(
  moduleFilename: string,
  resourcesPath: string | undefined,
  host: IrohHost
): string {
  const filename = nativeFilename(host)
  const { roots, source } = sdkRoots(moduleFilename, resourcesPath)
  const root = roots.find((candidate) =>
    existsSync(join(candidate, 'node_modules', '@number0', 'iroh', 'package.json'))
  )
  if (!root) {
    throw Object.assign(new Error('Staged Iroh SDK is missing'), { code: 'MODULE_NOT_FOUND' })
  }
  const sdk = confinedPath(join(root, 'node_modules', '@number0', 'iroh'), root)
  const metadata: { main?: unknown } = JSON.parse(
    readFileSync(confinedPath(join(sdk, 'package.json'), sdk), 'utf8')
  )
  let native: string
  if (typeof metadata.main === 'string' && SOURCE_NATIVE_MAIN.test(metadata.main)) {
    native = confinedPath(join(sdk, metadata.main), sdk)
  } else {
    if (source) {
      throw new Error('Source Iroh SDK has not been provisioned')
    }
    const colocated = join(sdk, filename)
    const packageName = filename.replace(/^iroh\./, 'iroh-').replace(/\.node$/, '')
    native = confinedPath(
      existsSync(colocated)
        ? colocated
        : join(root, 'node_modules', '@number0', packageName, filename),
      root
    )
  }
  if (!native.endsWith('.node')) {
    throw new Error('Iroh native must be a native addon')
  }
  return native
}

/** Load the selected addon directly; its native capability is checked by the bind boundary. */
export function loadIrohNativeModule(): IrohNativeModule {
  const resourcesPath =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : undefined
  return requireFromHere(resolveIrohNativePath(__filename, resourcesPath, detectNativeHostAbi()))
}
