#!/usr/bin/env node
// Installs the Orca dev client, rebuilding only when the Expo fingerprint of its native inputs
// changed. Builds are cached per fingerprint in the user cache dir, so every worktree reuses them.
//
//   node scripts/native-client.mjs ensure <ios|android> [--device <name|udid|serial>] [--rebuild]
//   node scripts/native-client.mjs fingerprint [--project <dir>] [--out <file>]
//   node scripts/native-client.mjs compare <base.json> <head.json> [--project <dir>] [--summary <file>]
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import nativeBuildCache from './native-build-cache.cjs'

const execFileAsync = promisify(execFile)
const PLATFORMS = ['ios', 'android']
const STAMP_FILE = '.orca-native-fingerprint'
const USAGE = `Usage:
  native-client.mjs ensure <ios|android> [--device <name|udid|serial>] [--rebuild]
  native-client.mjs fingerprint [--project <dir>] [--out <file>]
  native-client.mjs compare <base.json> <head.json> [--project <dir>] [--summary <file>]`

export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--rebuild' || arg === '--help' || arg === '-h') {
      flags[arg.replace(/^-+/, '')] = true
    } else if (arg.startsWith('--')) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`)
      }
      flags[arg.slice(2)] = value
      i++
    } else {
      positional.push(arg)
    }
  }
  return { command: positional[0], positional: positional.slice(1), flags }
}

function log(message) {
  console.log(`[native] ${message}`)
}

function shortHash(hash) {
  return hash.slice(0, 12)
}

function runInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(`${path.basename(command)} ${args.join(' ')} exited with ${signal ?? code}`)
        )
      }
    })
  })
}

function readStamp(nativeDir) {
  try {
    return fs.readFileSync(path.join(nativeDir, STAMP_FILE), 'utf8').trim()
  } catch {
    return null
  }
}

// --- iOS Simulator ---------------------------------------------------------------------------

export function pickIosSimulator(devicesJson, requested) {
  const simulators = Object.entries(devicesJson.devices ?? {}).flatMap(([runtime, list]) =>
    runtime.includes('iOS') ? list.filter((device) => device.isAvailable !== false) : []
  )
  if (requested) {
    return (
      simulators.find((device) => device.udid === requested) ??
      simulators.find((device) => device.name === requested) ??
      null
    )
  }
  return simulators.find((device) => device.state === 'Booted') ?? null
}

async function installOnIosSimulator(appPath, requested) {
  if (process.platform !== 'darwin') {
    throw new Error('iOS Simulator installs require macOS and Xcode.')
  }
  const { stdout } = await execFileAsync(
    'xcrun',
    ['simctl', 'list', 'devices', 'available', '-j'],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }
  )
  const simulator = pickIosSimulator(JSON.parse(stdout), requested)
  if (!simulator) {
    throw new Error(
      requested
        ? `No available iOS simulator named or with UDID "${requested}".`
        : 'No booted iOS simulator. Boot one or pass --device <name|udid>.'
    )
  }
  if (simulator.state !== 'Booted') {
    // Boots headless; Simulator.app is not opened or focused.
    log(`Booting ${simulator.name}`)
    await execFileAsync('xcrun', ['simctl', 'boot', simulator.udid])
  }
  await execFileAsync('xcrun', ['simctl', 'install', simulator.udid, appPath])
  return `${simulator.name} (${simulator.udid})`
}

// --- Android ---------------------------------------------------------------------------------

function adbPath() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (sdk) {
    const candidate = path.join(
      sdk,
      'platform-tools',
      process.platform === 'win32' ? 'adb.exe' : 'adb'
    )
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return 'adb'
}

export function parseAdbDevices(stdout) {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial)
}

async function resolveAndroidSerial(adb, requested) {
  const { stdout } = await execFileAsync(adb, ['devices'], { encoding: 'utf8' })
  const serials = parseAdbDevices(stdout)
  if (requested) {
    if (serials.includes(requested)) {
      return requested
    }
    for (const serial of serials.filter((s) => s.startsWith('emulator-'))) {
      const { stdout: avd } = await execFileAsync(adb, ['-s', serial, 'emu', 'avd', 'name'], {
        encoding: 'utf8'
      }).catch(() => ({ stdout: '' }))
      if (avd.split(/\r?\n/)[0].trim() === requested) {
        return serial
      }
    }
    throw new Error(`No running Android device or emulator matches "${requested}".`)
  }
  if (process.env.ANDROID_SERIAL && serials.includes(process.env.ANDROID_SERIAL)) {
    return process.env.ANDROID_SERIAL
  }
  if (serials.length === 1) {
    return serials[0]
  }
  throw new Error(
    serials.length === 0
      ? 'No running Android emulator or device. Start one first.'
      : `Several Android devices are connected (${serials.join(', ')}); pass --device <serial|avd>.`
  )
}

async function installOnAndroid(apkPath, requested) {
  const adb = adbPath()
  const serial = await resolveAndroidSerial(adb, requested)
  // -d: a cached build may carry an older versionCode than the one installed.
  await execFileAsync(adb, ['-s', serial, 'install', '-r', '-d', apkPath], { encoding: 'utf8' })
  return serial
}

// --- Commands --------------------------------------------------------------------------------

async function ensure(mobileRoot, platform, flags) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`ensure needs a platform: ios or android\n${USAGE}`)
  }
  const device = flags.device
  const cacheDir = nativeBuildCache.resolveCacheDir()
  log(`Computing the ${platform} native fingerprint...`)
  const { hash } = await nativeBuildCache.createNativeFingerprint(mobileRoot, platform)
  const key = nativeBuildCache.cacheEntryKey(
    platform,
    hash,
    nativeBuildCache.buildVariant(platform)
  )

  const cached = flags.rebuild ? null : nativeBuildCache.findCachedBuild(cacheDir, key)
  if (cached) {
    log(`HIT ${platform} fingerprint ${shortHash(hash)}: installing the cached build`)
    log(`  ${cached}`)
    try {
      const target =
        platform === 'ios'
          ? await installOnIosSimulator(cached, device)
          : await installOnAndroid(cached, device)
      log(`Installed on ${target}. No native rebuild needed.`)
      log('Start Metro with: pnpm start --dev-client')
      return
    } catch (error) {
      log(`Installing the cached build failed: ${error.message}`)
      log('Falling back to a fresh build.')
    }
  } else {
    log(
      flags.rebuild
        ? `REBUILD ${platform} fingerprint ${shortHash(hash)} (--rebuild)`
        : `MISS ${platform} fingerprint ${shortHash(hash)}: native inputs changed, building`
    )
  }

  const { ensureMobileExpoCli, getMobileExpoExecutablePath } = await import('./mobile-expo-cli.mjs')
  await ensureMobileExpoCli(mobileRoot)
  const expo = getMobileExpoExecutablePath(mobileRoot)

  // `expo run` only prebuilds when the native directory is missing, so a directory generated from
  // older inputs would be built and cached under the new fingerprint.
  const nativeDir = path.join(mobileRoot, platform)
  if (readStamp(nativeDir) !== hash) {
    if (fs.existsSync(nativeDir)) {
      log(`Regenerating ${platform}/ (it was generated from different native inputs)`)
      fs.rmSync(nativeDir, { recursive: true, force: true })
    }
    await runInherited(expo, ['prebuild', '--platform', platform, '--no-install'], {
      cwd: mobileRoot
    })
    fs.writeFileSync(path.join(nativeDir, STAMP_FILE), `${hash}\n`)
  }

  await runInherited(
    expo,
    [`run:${platform}`, '--no-bundler', ...(device ? ['--device', device] : [])],
    {
      cwd: mobileRoot,
      env: { ...process.env, [nativeBuildCache.CACHE_MODE_ENV]: 'store' }
    }
  )

  const stored = nativeBuildCache.findCachedBuild(cacheDir, key)
  if (stored) {
    log(`Built, installed, and cached ${platform} fingerprint ${shortHash(hash)}`)
    log(`  ${stored}`)
  } else {
    log(
      platform === 'ios'
        ? 'Built and installed, but not cached: Expo caches iOS Simulator builds only.'
        : 'Built and installed, but the build was not cached.'
    )
  }
  log('Start Metro with: pnpm start --dev-client')
}

async function fingerprint(mobileRoot, flags) {
  const result = {}
  for (const platform of PLATFORMS) {
    result[platform] = await nativeBuildCache.createNativeFingerprint(mobileRoot, platform)
    log(`${platform} ${result[platform].hash}`)
  }
  if (flags.out) {
    fs.writeFileSync(flags.out, JSON.stringify(result))
  }
}

function describeSource(source) {
  return source.type === 'contents' ? source.id : `${source.type} ${source.filePath}`
}

export function describeDiffItem(item) {
  if (item.op === 'added') {
    return `added ${describeSource(item.addedSource)}`
  }
  if (item.op === 'removed') {
    return `removed ${describeSource(item.removedSource)}`
  }
  return `changed ${describeSource(item.afterSource)}`
}

const MAX_LISTED_SOURCES = 25

async function compare(mobileRoot, [basePath, headPath], flags) {
  if (!basePath || !headPath) {
    throw new Error(`compare needs two fingerprint files\n${USAGE}`)
  }
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'))
  const head = JSON.parse(fs.readFileSync(headPath, 'utf8'))
  const { diffFingerprints } = nativeBuildCache.loadFingerprintModule(mobileRoot)
  const changedPlatforms = PLATFORMS.filter(
    (platform) => base[platform]?.hash !== head[platform]?.hash
  )

  const lines = ['## Mobile native fingerprint', '']
  if (changedPlatforms.length === 0) {
    lines.push('Unchanged: existing dev-client builds still work with this PR.')
  } else {
    lines.push(
      `**Changed for ${changedPlatforms.join(' and ')}.** Dev clients need a native rebuild ` +
        '(`pnpm native ensure <ios|android>`).'
    )
  }
  lines.push('', '| Platform | Base | Head |', '| --- | --- | --- |')
  for (const platform of PLATFORMS) {
    lines.push(
      `| ${platform} | \`${shortHash(base[platform]?.hash ?? 'none')}\` | \`${shortHash(head[platform]?.hash ?? 'none')}\` |`
    )
  }
  for (const platform of changedPlatforms) {
    const items = diffFingerprints(base[platform], head[platform]).map(describeDiffItem)
    lines.push('', `<details><summary>${platform}: ${items.length} changed sources</summary>`, '')
    for (const item of items.slice(0, MAX_LISTED_SOURCES)) {
      lines.push(`- ${item}`)
    }
    if (items.length > MAX_LISTED_SOURCES) {
      lines.push(`- ...and ${items.length - MAX_LISTED_SOURCES} more`)
    }
    lines.push('', '</details>')
  }
  const markdown = `${lines.join('\n')}\n`
  console.log(markdown)
  if (flags.summary) {
    fs.appendFileSync(flags.summary, markdown)
  }
  if (changedPlatforms.length > 0 && process.env.GITHUB_ACTIONS) {
    console.log(
      `::warning title=Mobile native fingerprint changed::This PR changes native inputs for ${changedPlatforms.join(' and ')}; dev clients need a native rebuild.`
    )
  }
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  if (!command || flags.help || flags.h) {
    console.log(USAGE)
    return
  }
  const mobileRoot = path.resolve(flags.project ?? path.join(import.meta.dirname, '..'))
  if (command === 'ensure') {
    await ensure(mobileRoot, positional[0], flags)
  } else if (command === 'fingerprint') {
    await fingerprint(mobileRoot, flags)
  } else if (command === 'compare') {
    await compare(mobileRoot, positional, flags)
  } else {
    throw new Error(`Unknown command "${command}"\n${USAGE}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(`[native] ${error.message}`)
    process.exit(1)
  })
}
