#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_RESPONSE_DETAIL_LENGTH = 240

export const MOBILE_RUNTIME_TARGETS = ['physical', 'android-emulator', 'ios-simulator', 'web']

export class MobileRuntimePreflightError extends Error {
  constructor(code, message, recoveryCommand) {
    super(message)
    this.name = 'MobileRuntimePreflightError'
    this.code = code
    this.stage = 'bundle_readiness'
    this.recoveryCommand = recoveryCommand
  }
}

export async function verifyMobileRuntimePreflight({
  publishedUrl,
  target,
  fetchStatus = fetch,
  configureAndroidReverse = configureAdbReverse
}) {
  const sourceUrl = parsePublishedUrl(publishedUrl, target)
  const port = Number(sourceUrl.port || 80)
  const recoveryCommand = recoveryCommandFor(target, port)

  if (target === 'physical' && isLoopbackHost(sourceUrl.hostname)) {
    throw new MobileRuntimePreflightError(
      'loopback_publication',
      `Physical devices cannot reach ${sourceUrl.hostname}. Publish Metro on a LAN address.`,
      recoveryCommand
    )
  }

  let deviceUrl = sourceUrl
  if (target === 'android-emulator') {
    try {
      await configureAndroidReverse(port)
    } catch (error) {
      throw preflightFailure(
        'android_reverse_failed',
        error,
        recoveryCommand,
        'Android emulator port forwarding failed'
      )
    }
    deviceUrl = new URL(sourceUrl)
    deviceUrl.hostname = '127.0.0.1'
  }

  const statusUrl = new URL('/status', sourceUrl)
  let response
  try {
    response = await fetchStatus(statusUrl)
  } catch (error) {
    throw preflightFailure(
      'metro_unreachable',
      error,
      recoveryCommand,
      `Metro did not answer at ${statusUrl.toString()}`
    )
  }

  const responseText = boundDetail(await response.text())
  if (!response.ok || !responseText.includes('packager-status:running')) {
    throw new MobileRuntimePreflightError(
      'metro_unexpected_response',
      `Metro returned ${response.status}: ${responseText || 'empty response'}`,
      recoveryCommand
    )
  }

  return {
    stage: 'bundle_readiness',
    sourceUrl: sourceUrl.toString().replace(/\/$/, ''),
    deviceUrl: deviceUrl.toString().replace(/\/$/, ''),
    statusUrl: statusUrl.toString(),
    recoveryCommand
  }
}

export function recoveryCommandFor(target, port) {
  if (target === 'physical') {
    return `pnpm start -- --host lan --port ${port}`
  }
  if (target === 'android-emulator') {
    return `adb reverse tcp:${port} tcp:${port} && pnpm start -- --host localhost --port ${port}`
  }
  return `pnpm start -- --host localhost --port ${port}`
}

async function configureAdbReverse(port) {
  await execFileAsync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], { timeout: 10_000 })
}

function parsePublishedUrl(publishedUrl, target) {
  if (!MOBILE_RUNTIME_TARGETS.includes(target)) {
    throw new MobileRuntimePreflightError(
      'invalid_target',
      `Unknown mobile runtime target: ${target}`,
      'node scripts/mobile-runtime-preflight.mjs --help'
    )
  }
  try {
    const url = new URL(publishedUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Metro URL must use http or https')
    }
    return url
  } catch (error) {
    throw preflightFailure(
      'invalid_metro_url',
      error,
      'pnpm start -- --host lan',
      'Metro published an invalid URL'
    )
  }
}

function preflightFailure(code, error, recoveryCommand, prefix) {
  const errorCode =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.name
        : 'unknown_error'
  const message = error instanceof Error ? error.message : String(error)
  return new MobileRuntimePreflightError(
    code,
    `${prefix}: ${boundDetail(errorCode)}: ${boundDetail(message)}`,
    recoveryCommand
  )
}

function boundDetail(value) {
  const normalized = String(value)
    .replaceAll(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replaceAll(/\b(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replaceAll(/\s+/g, ' ')
    .trim()
  return normalized.length > MAX_RESPONSE_DETAIL_LENGTH
    ? `${normalized.slice(0, MAX_RESPONSE_DETAIL_LENGTH - 1)}…`
    : normalized
}

function isLoopbackHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

function parseArguments(argv) {
  const options = { publishedUrl: '', target: '' }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--url') {
      options.publishedUrl = argv[++index] ?? ''
    } else if (argument === '--target') {
      options.target = argv[++index] ?? ''
    } else if (argument === '--help' || argument === '-h') {
      return { help: true }
    }
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(
      'Usage: node scripts/mobile-runtime-preflight.mjs --url <metro-url> --target <physical|android-emulator|ios-simulator|web>'
    )
    return
  }
  if (!options.publishedUrl || !options.target) {
    throw new MobileRuntimePreflightError(
      'missing_argument',
      'Both --url and --target are required.',
      'node scripts/mobile-runtime-preflight.mjs --help'
    )
  }
  const result = await verifyMobileRuntimePreflight(options)
  console.log(`Bundle ready: ${result.deviceUrl}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof MobileRuntimePreflightError) {
      console.error(`[${error.stage}] ${error.code}: ${error.message}`)
      console.error(`Recovery: ${error.recoveryCommand}`)
    } else {
      console.error(error)
    }
    process.exitCode = 1
  })
}
