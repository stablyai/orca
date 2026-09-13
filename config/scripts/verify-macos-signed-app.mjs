import { open, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const machoMagic = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca'
])

function defaultRunner() {
  // The release build emits the same process boundary used by the app and CLI.
  return require('../../out/shared/child-process/run-process.js').runProcess
}

function defaultTermination() {
  return require('../../out/shared/child-process/process-tree-termination.js')
}

async function checked(run, program, args, input) {
  const result = await run({ program, args, input, maxOutputBytes: 1024 * 1024 })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(`${program} ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

async function readPlist(run, args) {
  const json = await checked(run, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', ...args])
  return JSON.parse(json)
}

async function collectSignedCode(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (/\.provisionprofile$|^embedded\.mobileprovision$/i.test(entry.name)) {
      throw new Error(`Provisioning profiles are forbidden in distributable macOS apps: ${path}`)
    }
    if (entry.isDirectory()) {
      await collectSignedCode(path, files)
    } else if (entry.isFile()) {
      const handle = await open(path, 'r')
      try {
        const magic = Buffer.alloc(4)
        const { bytesRead } = await handle.read(magic, 0, 4, 0)
        if (bytesRead === 4 && machoMagic.has(magic.toString('hex'))) {
          files.push(path)
        }
      } finally {
        await handle.close()
      }
    }
  }
  return files
}

export async function verifyMacAppSignature(appPath, { run = defaultRunner() } = {}) {
  const files = await collectSignedCode(appPath)
  if (files.length === 0) {
    throw new Error(`No Mach-O code found in ${appPath}`)
  }
  await checked(run, '/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--all-architectures',
    appPath
  ])
  for (const file of files) {
    await checked(run, '/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', file])
    const architectures = (await checked(run, '/usr/bin/lipo', ['-archs', file]))
      .trim()
      .split(/\s+/)
    if (architectures.some((arch) => !/^(arm64e?|x86_64h?|i386)$/.test(arch))) {
      throw new Error(`Unrecognized Mach-O architectures in ${file}: ${architectures.join(', ')}`)
    }
    for (const arch of architectures) {
      const xml = await checked(run, '/usr/bin/codesign', [
        '-d',
        '--arch',
        arch,
        '--entitlements',
        ':-',
        file
      ])
      if (!xml.trim()) {
        continue
      }
      const json = await checked(run, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], xml)
      const entitlements = JSON.parse(json)
      if (
        [
          'keychain-access-groups',
          'com.apple.application-identifier',
          'com.apple.developer.team-identifier'
        ].some((key) => Object.hasOwn(entitlements, key))
      ) {
        throw new Error(`Restricted passkey entitlement is forbidden: ${file} (${arch})`)
      }
    }
  }
}

export async function verifyMacAppLaunch(
  appPath,
  { run = defaultRunner(), survivalMs = 10_000, termination = defaultTermination() } = {}
) {
  const plist = await readPlist(run, [join(appPath, 'Contents', 'Info.plist')])
  const executable = plist.CFBundleExecutable
  if (
    typeof executable !== 'string' ||
    !executable ||
    /[/\\]/.test(executable) ||
    executable === '..'
  ) {
    throw new Error(`Invalid CFBundleExecutable in ${appPath}`)
  }
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'orca-mac-launch-'))
  const isolatedHome = join(isolatedRoot, 'home')
  await mkdir(isolatedHome)
  const env = { ...process.env }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'ORCA_E2E_FOREGROUND',
    'CODEX_HOME',
    'ORCA_CODEX_HOME'
  ]) {
    delete env[key]
  }
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ORCA_E2E_HOME_DIR: isolatedHome,
    ORCA_E2E_USER_DATA_DIR: join(isolatedRoot, 'user-data'),
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_E2E_HEADLESS: '1'
  })
  let survived = false
  let terminated = false
  try {
    const result = await run({
      program: join(appPath, 'Contents', 'MacOS', executable),
      args: [],
      env,
      cwd: isolatedHome,
      timeoutMs: survivalMs,
      detached: true,
      terminationBarrier: {
        signal: (child, signal) => {
          // An exited root can leave inherited output pipes open until the timeout.
          survived = child.exitCode === null && child.signalCode === null && !!child.pid
          return termination.signalProcessTree(child, signal)
        },
        force: async (child) => {
          terminated = await termination.forceTerminateProcessTree(child)
          return terminated
        }
      },
      maxOutputBytes: 1024 * 1024
    })
    // A timeout is success only here: the runner observed a live app for the full interval.
    if (!result.timedOut || !survived) {
      throw new Error(
        `Signed app exited before ${survivalMs}ms (code=${result.code}, signal=${result.signal}): ${result.stderr}`
      )
    }
    if (!terminated) {
      throw new Error('Could not verify launch-probe process tree termination')
    }
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true })
  }
}

export async function verifyMacSignedApp(context, options = {}) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  await verifyMacAppSignature(appPath, options)
  await verifyMacAppLaunch(appPath, options)
  console.log(
    `[verify-macos-signed-app] ${appPath}: signature, entitlement policy and background launch passed`
  )
}
