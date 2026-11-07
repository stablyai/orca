import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { IROH_BUILD_IDENTITY, IROH_PREBUILD_FILES, verifyIrohPrebuild } from './iroh-prebuild.mjs'
import { readManifest } from './orcad-prebuild-slot-contents.mjs'
import { ensurePinnedNodeExecutable } from './pinned-node-downloads.mjs'

const ROOT = resolve(import.meta.dirname, '../../../..')
// Keep these identical to the native GNU qualification lanes in node-server-tests.yml.
const MANYLINUX_IMAGES = {
  x64: 'quay.io/pypa/manylinux_2_28_x86_64@sha256:407f771c51a2c3e83ebe5a7970b4289ead3a6db21d9b9c089168775cad11d328',
  arm64:
    'quay.io/pypa/manylinux_2_28_aarch64@sha256:c22ffd129ac99a8a42d1f2c2f4e88a9089288dd9ee987a7092da1c7dc48f27a9'
}

/** Reuse qualified patched bytes, or run the existing producer only on the matching native host. */
export async function ensureIrohPrebuild({
  targetPlatform,
  arch,
  libc = targetPlatform === 'linux' ? 'glibc' : undefined,
  root = ROOT,
  prebuildsDir = process.env.ORCAD_PREBUILDS_DIR || join(root, 'out', 'orcad-prebuilds'),
  platform = process.platform,
  hostArch = process.arch,
  hostLibc = platform === 'linux'
    ? process.report?.getReport()?.header?.glibcVersionRuntime
      ? 'glibc'
      : 'musl'
    : undefined,
  run = spawnSync,
  ensureNode = ensurePinnedNodeExecutable
}) {
  const slot = `${targetPlatform}-${arch}${targetPlatform === 'linux' ? `-${libc}` : ''}`
  if (slot === 'darwin-x64') {
    return
  }
  if (!Object.hasOwn(IROH_PREBUILD_FILES, slot)) {
    throw new Error(`Unsupported Iroh packaging target: ${slot}`)
  }
  root = resolve(root)
  prebuildsDir = resolve(prebuildsDir)
  const filename = IROH_PREBUILD_FILES[slot].split('/').at(-1)
  const packageName = `@number0/${filename.replace(/^iroh\./, 'iroh-').replace(/\.node$/, '')}`
  const loader = JSON.parse(
    readFileSync(join(root, 'node_modules', '@number0', 'iroh', 'package.json'), 'utf8')
  )
  if (
    loader.version !== IROH_BUILD_IDENTITY.sdkVersion ||
    loader.optionalDependencies?.[packageName] !== loader.version
  ) {
    throw new Error(`Packaging Iroh requires the pinned ${packageName} SDK declaration.`)
  }
  /** Read the manifest again after production; a successful command alone does not qualify its output. */
  function verify() {
    return verifyIrohPrebuild({
      slotDir: join(prebuildsDir, slot),
      slot,
      entry: readManifest(prebuildsDir)?.slots?.[slot],
      version: loader.version
    })
  }
  let cacheError
  try {
    return verify()
  } catch (error) {
    cacheError = error
  }
  const lane =
    targetPlatform === 'linux' && libc === 'glibc'
      ? `pinned manylinux 2.28 qualification lane on a native Linux ${arch} runner`
      : `native ${targetPlatform}/${arch}${libc ? `/${libc}` : ''} qualification runner`
  const instructions =
    `Run pnpm build:orcad-prebuilds --slot=${slot} in the ${lane}, ` +
    'then copy out/orcad-prebuilds here or set ORCAD_PREBUILDS_DIR to that verified directory.'
  if (
    platform !== targetPlatform ||
    hostArch !== arch ||
    (targetPlatform === 'linux' && libc === 'musl' && hostLibc !== 'musl')
  ) {
    throw new Error(
      `Packaging Iroh requires a verified patched ${slot} prebuild in ${prebuildsDir}: ${cacheError.message}. ` +
        `${instructions} Cross-host, cross-architecture or foreign-libc SDK compilation is not supported.`,
      { cause: cacheError }
    )
  }
  if (prebuildsDir !== join(root, 'out', 'orcad-prebuilds')) {
    throw new Error(
      `ORCAD_PREBUILDS_DIR has no verified patched ${slot} SDK: ${cacheError.message}. ` +
        `${instructions} Or unset ORCAD_PREBUILDS_DIR to build them in this workspace.`,
      { cause: cacheError }
    )
  }
  if (targetPlatform !== 'linux' || libc === 'musl') {
    const tools =
      targetPlatform === 'linux'
        ? 'a native musl C/C++ toolchain, bash, tar, xz, and Python 3'
        : targetPlatform === 'darwin'
          ? 'Xcode Command Line Tools, bash, tar, xz, and Python 3'
          : 'Visual Studio C++ build tools (including the target architecture), Windows SDK, System32 tar.exe, and Python 3'
    const node = await ensureNode({
      target: slot,
      cacheDir: join(root, 'out', 'node-runtime-cache')
    })
    const result = run(
      node,
      [
        join(
          root,
          'config',
          'scripts',
          'orcad-distribution',
          'prebuilds',
          'build-orcad-prebuilds.mjs'
        ),
        `--slot=${slot}`
      ],
      { cwd: root, stdio: 'inherit' }
    )
    if (result.error || result.status !== 0) {
      throw new Error(
        `Cannot provision patched ${slot} Iroh: the native producer requires ${tools} and must finish successfully. ` +
          `${instructions} See the build output above.`,
        { cause: result.error ?? cacheError }
      )
    }
    return verify()
  }
  const runtime = run('docker', ['info', '--format', '{{.Host.Security.Rootless}}'], {
    cwd: root,
    encoding: 'utf8'
  })
  if (runtime.error) {
    throw new Error(`Provisioning ${slot} Iroh requires working Docker.`, { cause: runtime.error })
  }
  // Rootless Podman otherwise maps --user to a different host UID, making the workspace unwritable.
  const userNamespace =
    runtime.status === 0 && runtime.stdout.trim() === 'true' ? ['--userns=keep-id'] : []
  const node = await ensureNode({
    target: slot,
    cacheDir: join(root, 'out', 'node-runtime-cache')
  })
  const home = join(root, 'out', 'orcad-prebuild-work', 'home')
  mkdirSync(home, { recursive: true })
  const result = run(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      ...userNamespace,
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-v',
      `${root}:/work`,
      '-w',
      '/work',
      '-e',
      'HOME=/work/out/orcad-prebuild-work/home',
      '-e',
      'ORCA_NODE_RUNTIME_CACHE_DIR=/work/out/node-runtime-cache',
      '-e',
      'ORCA_BACKGROUND_LAUNCH=1',
      '-e',
      'CC=gcc',
      '-e',
      'CXX=g++',
      '-e',
      'PYTHON=/opt/python/cp312-cp312/bin/python3',
      MANYLINUX_IMAGES[arch],
      'bash',
      '-ec',
      'export PATH="${1%/*}:$PATH"; exec "$1" config/scripts/orcad-distribution/prebuilds/build-orcad-prebuilds.mjs "--slot=$2"',
      'build-iroh',
      `/work/${relative(root, node)}`,
      slot
    ],
    { cwd: root, stdio: 'inherit' }
  )
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot provision ${slot} Iroh: the manylinux 2.28 producer requires working Docker and must finish successfully. See the build output above.`,
      { cause: result.error ?? cacheError }
    )
  }
  return verify()
}
