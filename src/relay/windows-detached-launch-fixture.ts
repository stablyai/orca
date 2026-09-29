import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchDetachedWindowsRelay } from './windows-detached-launch'

type Pointer = number | bigint
type NativeApi = {
  CreateJobObjectW(security: null, name: Pointer): Pointer
  SetInformationJobObject(job: Pointer, kind: number, data: Pointer, size: number): number
  AssignProcessToJobObject(job: Pointer, process: Pointer): number
  GetCurrentProcess(): Pointer
  IsProcessInJob(process: Pointer, job: Pointer | null, result: Pointer): number
  OpenJobObjectW(access: number, inherit: number, name: Pointer): Pointer
  CreateFileW(
    path: Pointer,
    access: number,
    share: number,
    security: Pointer,
    creation: number,
    flags: number,
    template: null
  ): Pointer
  GetFinalPathNameByHandleW(handle: Pointer, buffer: Pointer, size: number, flags: number): number
  GetProcessTimes(
    process: Pointer,
    creation: Pointer,
    exit: Pointer,
    kernel: Pointer,
    user: Pointer
  ): number
  OpenProcess(access: number, inherit: number, pid: number): Pointer
  WaitForSingleObject(handle: Pointer, timeout: number): number
  TerminateProcess(handle: Pointer, code: number): number
  GetHandleInformation(handle: Pointer, flags: Pointer): number
  CloseHandle(handle: Pointer): number
}
type Ffi = {
  ptr(value: ArrayBufferView): Pointer
  dlopen<T>(
    name: string,
    symbols: Record<string, { args: string[]; returns: string }>
  ): { symbols: T; close(): void }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture runs only on the explicitly selected Bun executable.
const ffi = createRequire(__filename)('bun:ffi') as Ffi
const library = ffi.dlopen<NativeApi>('kernel32.dll', {
  CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'u64' },
  SetInformationJobObject: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'i32' },
  AssignProcessToJobObject: { args: ['u64', 'u64'], returns: 'i32' },
  GetCurrentProcess: { args: [], returns: 'u64' },
  IsProcessInJob: { args: ['u64', 'u64', 'ptr'], returns: 'i32' },
  OpenJobObjectW: { args: ['u32', 'i32', 'ptr'], returns: 'u64' },
  CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'], returns: 'u64' },
  GetFinalPathNameByHandleW: { args: ['u64', 'ptr', 'u32', 'u32'], returns: 'u32' },
  GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'u64' },
  WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
  TerminateProcess: { args: ['u64', 'u32'], returns: 'i32' },
  GetHandleInformation: { args: ['u64', 'ptr'], returns: 'i32' },
  CloseHandle: { args: ['u64'], returns: 'i32' }
})
const api = library.symbols
const objectLibrary = ffi.dlopen<{
  NtQueryObject(
    handle: Pointer,
    kind: number,
    buffer: Pointer,
    size: number,
    returned: Pointer
  ): number
}>('ntdll.dll', {
  NtQueryObject: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'u32' }
})
function markerMatches(handle: Pointer): boolean {
  const buffer = new Uint8Array(4096)
  const returned = new Uint32Array(1)
  const status = objectLibrary.symbols.NtQueryObject(
    handle,
    2,
    ffi.ptr(buffer),
    buffer.length,
    ffi.ptr(returned)
  )
  if (status === 0xc0000008) {
    return false
  }
  assert.equal(status, 0, 'unable to identify possible inherited marker handle')
  const view = new DataView(buffer.buffer)
  const length = view.getUint16(0, true)
  const offset = Number(view.getBigUint64(8, true) - BigInt(ffi.ptr(buffer)))
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset + length <= buffer.length)
  const type = Buffer.from(buffer.buffer, offset, length).toString('utf16le')
  if (type !== 'File') {
    assert(type.length > 0, 'unidentified native object type')
    return false
  }
  const path = new Uint16Array(32768)
  const size = api.GetFinalPathNameByHandleW(handle, ffi.ptr(path), path.length, 0)
  assert(size > 0 && size < path.length, 'unable to identify possible inherited file')
  return Buffer.from(path.buffer, 0, size * 2)
    .toString('utf16le')
    .endsWith('inheritable-marker.txt')
}
function utf16(value: string): Uint16Array {
  const output = new Uint16Array(value.length + 1)
  for (let i = 0; i < value.length; i++) {
    output[i] = value.charCodeAt(i)
  }
  return output
}
function identity(handle: Pointer): string {
  const times = Array.from({ length: 4 }, () => new BigUint64Array(1))
  assert(
    api.GetProcessTimes(
      handle,
      ffi.ptr(times[0]),
      ffi.ptr(times[1]),
      ffi.ptr(times[2]),
      ffi.ptr(times[3])
    )
  )
  return times[0][0].toString()
}
function member(job: Pointer): boolean {
  const answer = new Uint32Array(1)
  assert(api.IsProcessInJob(api.GetCurrentProcess(), job, ffi.ptr(answer)))
  return answer[0] !== 0
}
function publish(path: string, value: string): void {
  writeFileSync(`${path}.pending`, value)
  renameSync(`${path}.pending`, path)
}
async function waitFor(path: string): Promise<void> {
  const deadline = performance.now() + 8_000
  while (!existsSync(path)) {
    assert(performance.now() < deadline, `timed out waiting for ${path}`)
    await delay(25)
  }
}
async function main(): Promise<void> {
  const [mode, directory, jobName, markerHandle, ...args] = process.argv.slice(2)
  assert(mode && directory)
  // Every detached child exits independently even if the test runner is killed.
  const watchdog = setTimeout(() => process.exit(2), 15_000)
  try {
    if (mode === 'inspect') {
      const receipt = JSON.parse(readFileSync(join(directory, 'owned-child.json'), 'utf8'))
      assert(Number.isInteger(receipt.pid) && typeof receipt.creation === 'string')
      const handle = api.OpenProcess(0x100000 | 0x1000 | 1, 0, receipt.pid)
      assert(handle, 'cleanup unverifiable: cannot open owned process; preserve evidence')
      try {
        if (identity(handle) !== receipt.creation) {
          return
        }
        writeFileSync(join(directory, 'stop'), '')
        const status = api.WaitForSingleObject(handle, 10_000)
        if (status === 258) {
          assert(api.TerminateProcess(handle, 2), 'owned child could not be terminated')
          assert.equal(api.WaitForSingleObject(handle, 3_000), 0, 'owned child did not terminate')
          throw new Error('Owned child required forced cleanup; preserve evidence')
        }
        assert.equal(status, 0, 'owned child exit is unverifiable')
      } finally {
        api.CloseHandle(handle)
      }
      return
    }
    assert(jobName)
    const name = utf16(jobName)
    if (mode === 'child') {
      assert(markerHandle)
      const job = api.OpenJobObjectW(4, 0, ffi.ptr(name))
      assert(job, 'parent job must still exist while child records membership')
      let childInJob: boolean
      try {
        childInJob = member(job)
      } finally {
        api.CloseHandle(job)
      }
      const markerInherited = markerMatches(BigInt(markerHandle))
      publish(
        join(directory, 'child.json'),
        JSON.stringify({
          pid: process.pid,
          creation: identity(api.GetCurrentProcess()),
          args,
          childInJob,
          markerInherited
        })
      )
      process.stdout.write('child stdout: 雪 🐳\n')
      process.stderr.write('child stderr: λ\n')
      const deadline = performance.now() + 10_000
      let tick = 0
      while (!existsSync(join(directory, 'stop')) && performance.now() < deadline) {
        publish(join(directory, 'tick'), String(++tick))
        if (
          existsSync(join(directory, 'rotated')) &&
          !existsSync(join(directory, 'rotation-written'))
        ) {
          process.stdout.write('after rotation stdout\n')
          process.stderr.write('after rotation stderr\n')
          writeFileSync(join(directory, 'rotation-written'), '')
        }
        await delay(50)
      }
      return
    }
    assert.equal(mode, 'launch')
    const job = api.CreateJobObjectW(null, ffi.ptr(name))
    assert(job)
    const limits = new Uint8Array(144)
    new DataView(limits.buffer).setUint32(16, 0x800 | 0x2000, true)
    assert(api.SetInformationJobObject(job, 9, ffi.ptr(limits), limits.length))
    assert(api.AssignProcessToJobObject(job, api.GetCurrentProcess()))
    assert(member(job), 'launcher must actually belong to the kill-on-close job')
    const security = new Uint8Array(24)
    const view = new DataView(security.buffer)
    view.setUint32(0, 24, true)
    view.setUint32(16, 1, true)
    const markerPath = utf16(join(directory, 'inheritable-marker.txt'))
    const marker = api.CreateFileW(
      ffi.ptr(markerPath),
      0x40000000,
      7,
      ffi.ptr(security),
      4,
      0x80,
      null
    )
    assert(marker && BigInt.asUintN(64, BigInt(marker)) !== 0xffffffffffffffffn)
    const markerFlags = new Uint32Array(1)
    assert(api.GetHandleInformation(marker, ffi.ptr(markerFlags)))
    assert.equal(markerFlags[0] & 1, 1, 'marker handle must be inheritable')
    assert(markerMatches(marker), 'marker identification positive control failed')
    const pid = launchDetachedWindowsRelay({
      executable: process.execPath,
      args: [__filename, 'child', directory, jobName, String(marker), ...args],
      cwd: directory,
      stdoutPath: join(directory, 'stdout.log'),
      stderrPath: join(directory, 'stderr.log')
    })
    const childHandle = api.OpenProcess(0x100000 | 0x1000, 0, pid)
    assert(childHandle, 'unable to capture detached child identity')
    try {
      publish(
        join(directory, 'owned-child.json'),
        JSON.stringify({ pid, creation: identity(childHandle) })
      )
    } finally {
      api.CloseHandle(childHandle)
    }
    await waitFor(join(directory, 'child.json'))
    writeFileSync(join(directory, 'launch.json'), JSON.stringify({ pid, parentInJob: member(job) }))
    api.CloseHandle(marker)
    // Process exit closes our last job handle: any child that failed breakaway dies with us.
    process.exit(0)
  } finally {
    clearTimeout(watchdog)
    objectLibrary.close()
    library.close()
  }
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
