#!/usr/bin/env node
// Measures mobile-web package download throughput over the real mobile RPC transports.
//
//   node mobile/scripts/measure-mobile-web-package-download.mjs \
//     --root out/mobile-web-rnw --paths direct,relay --rtt 0,40,120 --concurrency 1,4
//
// --rtt values are full round-trip milliseconds injected on the loopback socket (half per
// hop), so a cloud-relay round trip can be modelled without a production relay.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const scriptDirectory = import.meta.dirname
const repositoryRoot = resolve(scriptDirectory, '..', '..')

const options = parseArguments(process.argv.slice(2))
// Why: the bundle keeps `ws` external, so it has to live inside the repo to resolve it.
const buildDirectory = mkdtempSync(join(repositoryRoot, 'node_modules', '.orca-measure-'))
try {
  const { measureMobileWebPackageDownload } = await bundleHarness(buildDirectory)
  const results = []
  for (const path of options.paths) {
    for (const rtt of options.rtts) {
      for (const concurrency of options.concurrencies) {
        for (const gzip of options.gzips) {
          const result = await measureMobileWebPackageDownload({
            path,
            packageRoot: options.packageRoot,
            oneWayDelayMs: rtt / 2,
            gzip,
            rangeBytes: options.rangeBytes,
            maxConcurrentRequests: concurrency
          })
          results.push(result)
          console.log(formatRow(result))
        }
      }
    }
  }
  console.log('')
  console.log(formatTable(results))
} finally {
  rmSync(buildDirectory, { recursive: true, force: true })
}

async function bundleHarness(outputDirectory) {
  const shimPath = join(outputDirectory, 'expo-crypto-shim.mjs')
  writeFileSync(
    shimPath,
    "import { randomBytes } from 'node:crypto'\n" +
      'export function getRandomBytes(length) { return new Uint8Array(randomBytes(length)) }\n' +
      'export default { getRandomBytes }\n'
  )
  const outfile = join(outputDirectory, 'harness.mjs')
  await esbuild.build({
    entryPoints: [join(scriptDirectory, 'mobile-web-package-download-measurement.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'error',
    absWorkingDir: repositoryRoot,
    alias: { 'expo-crypto': shimPath },
    external: ['ws', 'electron'],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'\nconst require = __createRequire(import.meta.url)\n"
    }
  })
  return import(pathToFileURL(outfile).href)
}

function parseArguments(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag.startsWith('--')) {
      flags.set(flag.slice(2), argv[index + 1])
      index += 1
    }
  }
  return {
    packageRoot: resolve(repositoryRoot, flags.get('root') ?? 'out/mobile-web-rnw'),
    paths: (flags.get('paths') ?? 'direct,relay').split(','),
    rtts: (flags.get('rtt') ?? '0').split(',').map(Number),
    concurrencies: (flags.get('concurrency') ?? '1').split(',').map(Number),
    gzips: (flags.get('gzip') ?? 'true').split(',').map((value) => value === 'true'),
    rangeBytes: Number(flags.get('range-kib') ?? '48') * 1024
  }
}

function formatRow(result) {
  return [
    result.path.padEnd(6),
    `rtt=${String(result.oneWayDelayMs * 2).padStart(3)}ms`,
    `conc=${String(result.maxConcurrentRequests).padStart(2)}`,
    `gzip=${result.gzip ? 'on ' : 'off'}`,
    `range=${String(result.rangeBytes / 1024).padStart(3)}KiB`,
    `${(result.wallMs / 1000).toFixed(1).padStart(7)}s`,
    `${(result.bytesPerSecond / 1_000_000).toFixed(2).padStart(6)} MB/s`,
    `chunks=${String(result.chunkRequests).padStart(4)}`,
    `wire=${(result.wireBytesToPhone / 1_048_576).toFixed(1).padStart(6)} MiB`,
    `p50=${result.latencyMedianMs.toFixed(1).padStart(7)}ms`,
    `p95=${result.latencyP95Ms.toFixed(1).padStart(7)}ms`,
    `peak=${result.peakInFlight}`
  ].join('  ')
}

function formatTable(results) {
  return results.map(formatRow).join('\n')
}
