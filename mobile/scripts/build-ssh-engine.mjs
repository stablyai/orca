import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, delimiter, dirname } from 'node:path'
import { unzipSync } from 'fflate'

const platform = process.argv[2]
if (platform !== 'android' && platform !== 'ios') {
  throw new Error('Usage: node scripts/build-ssh-engine.mjs android|ios')
}
const moduleRoot = resolve(import.meta.dirname, '../modules/orca-ssh-tunnel')
const mobileVersion = 'v0.0.0-20260908204917-8b95e45f8d3e'
const go = process.env.ORCA_GO_BINARY || 'go'
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: resolve(moduleRoot, 'engine'),
    env,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`)
  }
}
const tools = resolve(moduleRoot, 'engine/.tools')
mkdirSync(tools, { recursive: true })
const goDirectory = process.env.ORCA_GO_BINARY ? `${dirname(resolve(go))}${delimiter}` : ''
const env = {
  ...process.env,
  GOBIN: tools,
  PATH: `${tools}${delimiter}${goDirectory}${process.env.PATH}`
}
run(
  go,
  [
    'install',
    `golang.org/x/mobile/cmd/gomobile@${mobileVersion}`,
    `golang.org/x/mobile/cmd/gobind@${mobileVersion}`
  ],
  env
)

const gomobile = resolve(tools, process.platform === 'win32' ? 'gomobile.exe' : 'gomobile')
// gomobile init replaces the pinned gobind with @latest; bind initializes its own environment.
const output =
  platform === 'android'
    ? resolve(moduleRoot, 'android/libs/OrcaSshEngine.aar')
    : resolve(moduleRoot, 'ios/OrcaSshEngine.xcframework')
mkdirSync(resolve(moduleRoot, platform === 'android' ? 'android/libs' : 'ios'), { recursive: true })
run(
  gomobile,
  [
    'bind',
    ...(platform === 'android'
      ? [
          '-target=android',
          '-androidapi=24',
          '-ldflags=-extldflags=-Wl,-z,max-page-size=16384,-z,common-page-size=16384'
        ]
      : ['-target=ios,iossimulator', '-iosversion=15.1']),
    '-o',
    output,
    '.'
  ],
  env
)

if (platform === 'android') {
  // Android library modules cannot embed a local AAR as a transitive dependency.
  const entries = unzipSync(readFileSync(output))
  if (!entries['classes.jar']) {
    throw new Error('SSH engine AAR is missing classes.jar')
  }
  writeFileSync(resolve(moduleRoot, 'android/libs/OrcaSshEngine.jar'), entries['classes.jar'])
  let nativeLibraries = 0
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/^jni\/(arm64-v8a|armeabi-v7a|x86|x86_64)\/lib[a-zA-Z0-9_-]+\.so$/.test(name)) {
      continue
    }
    const destination = resolve(moduleRoot, 'android/libs', name)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes)
    nativeLibraries++
  }
  if (!nativeLibraries) {
    throw new Error('SSH engine AAR is missing native libraries')
  }
}
