import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'

export const compilerEnvironmentKey =
  /^(PATH|INCLUDE|LIB|LIBPATH|VCINSTALLDIR|VSINSTALLDIR|VisualStudioVersion|VSCMD_.+|VCTools.+|WindowsSDK.+|UniversalCRT.+|UCRTVersion)$/i
export const hash = (value) => createHash('sha256').update(value).digest('hex')

export function environmentReceipt(environment) {
  const entries = Object.entries(environment)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [name.toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right))
  assert.equal(
    new Set(entries.map(([name]) => name)).size,
    entries.length,
    'Duplicate environment keys'
  )
  return {
    hash: hash(JSON.stringify(entries)),
    versions: Object.fromEntries(
      entries.filter(
        ([name, value]) =>
          /^(visualstudioversion|vscmd_ver|windowssdkversion|vctoolsversion|vscmd_arg_tgt_arch)$/.test(
            name
          ) && /^(?:[\d.]+\\?|x64|amd64|arm64)$/.test(value)
      )
    ),
    compiler: Object.fromEntries(
      entries
        .filter(([name]) => compilerEnvironmentKey.test(name))
        .map(([name, value]) => [name, hash(value)])
    )
  }
}

export function changedEnvironmentNames(before, after) {
  const normalize = (environment) =>
    new Map(Object.entries(environment).map(([name, value]) => [name.toLowerCase(), value]))
  const original = normalize(before)
  const prepared = normalize(after)
  return [...new Set([...original.keys(), ...prepared.keys()])]
    .filter((name) => original.get(name) !== prepared.get(name))
    .sort()
}

export function processPhase(spec) {
  const name = basename(spec.program).toLowerCase()
  if (name === 'vswhere.exe') {
    return 'discovery'
  }
  if (name === 'capture-windows-native-environment.cmd') {
    return 'capture'
  }
  if (spec.args?.some((arg) => arg.endsWith('ensure-native-runtime.mjs'))) {
    return spec.args.includes('--check-only') ? 'probe' : 'preparation'
  }
  return spec.args?.includes('rebuild') ? 'addon-build' : 'other'
}

export function installNativeBenchmarkObserver(api, output, environment = process.env) {
  const original = api.runProcessSync
  const parent = environmentReceipt(environment)
  const receipt = { parentBefore: parent, parentAfter: parent, calls: [] }
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`)
  api.runProcessSync = (spec) => {
    const startedAt = new Date().toISOString()
    const start = performance.now()
    const childEnvironment = spec.env ?? environment
    const call = {
      phase: processPhase(spec),
      program: basename(spec.program),
      args: spec.args,
      startedAt,
      environment: environmentReceipt(childEnvironment),
      changedNames: changedEnvironmentNames(environment, childEnvironment)
    }
    try {
      const result = original(spec)
      Object.assign(call, {
        code: result.code,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
        stdoutSha256: hash(result.stdout ?? ''),
        stderrSha256: hash(result.stderr ?? ''),
        stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
        stderrBytes: Buffer.byteLength(result.stderr ?? '')
      })
      return result
    } catch (error) {
      call.error = error.message
      throw error
    } finally {
      call.durationMs = performance.now() - start
      call.finishedAt = new Date().toISOString()
      receipt.calls.push(call)
      receipt.parentAfter = environmentReceipt(environment)
      assert.equal(
        receipt.parentAfter.hash,
        parent.hash,
        'Compiler setup changed its parent environment'
      )
      writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`)
    }
  }
  return receipt
}

if (process.env.ORCA_NATIVE_BENCHMARK_TRACE) {
  const require = createRequire(import.meta.url)
  installNativeBenchmarkObserver(
    require('@orca/process-host'),
    process.env.ORCA_NATIVE_BENCHMARK_TRACE
  )
}
