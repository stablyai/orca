import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildJournalFileLock } from './build-journal-file-lock.mjs'

const directories = []
function builder(arch, glibcVersionRuntime) {
  vi.stubGlobal('process', {
    ...process,
    platform: 'linux',
    arch,
    report: { getReport: () => ({ header: { glibcVersionRuntime } }) }
  })
  const directory = mkdtempSync(join(tmpdir(), 'orca-journal-lock-build-'))
  directories.push(directory)
  const output = join(directory, 'journal-file-lock')
  const run = vi.fn(() => ({ code: 0, stdout: '', stderr: '' }))
  return { output, run }
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('journal lock Linux build contract', () => {
  it.each([
    [
      'x64',
      'quay.io/pypa/manylinux_2_28_x86_64@sha256:407f771c51a2c3e83ebe5a7970b4289ead3a6db21d9b9c089168775cad11d328'
    ],
    [
      'arm64',
      'quay.io/pypa/manylinux_2_28_aarch64@sha256:c22ffd129ac99a8a42d1f2c2f4e88a9089288dd9ee987a7092da1c7dc48f27a9'
    ]
  ])('uses the pinned server floor on newer %s glibc hosts', (arch, image) => {
    const { output, run } = builder(arch, '2.39')
    expect(buildJournalFileLock(output, arch, { run })).toBe(output)
    expect(run.mock.calls.map(([request]) => request.program)).toEqual(['docker'])
    expect(run.mock.calls[0][0].args).toEqual(
      expect.arrayContaining([
        image,
        `${join(import.meta.dirname, '../../../native/journal-file-lock')}:/source:ro`,
        'journal-file-lock'
      ])
    )
    expect(run.mock.calls[0][0].args.join(' ')).toContain('compiler=gcc;')
  })

  it.each(['2.28', '2.17', undefined])(
    'keeps the native compiler for floor/compat/musl hosts (%s)',
    (version) => {
      const { output, run } = builder('x64', version)
      buildJournalFileLock(output, 'x64', { run })
      expect(run.mock.calls.map(([request]) => request.program)).toEqual(['cc'])
      expect(run.mock.calls[0][0].args).toContain(output)
    }
  )

  it('keeps the desktop cross compiler in its separate floor image', () => {
    const { output, run } = builder('x64', '2.39')
    buildJournalFileLock(output, 'arm64', { glibcFloor: 'desktop', run })
    const [build, compile] = run.mock.calls.map(([request]) => request)
    expect(build.args.slice(0, 2)).toEqual(['build', '-t'])
    expect(compile.args).toContain(build.args[2])
    expect(compile.args.join(' ')).toContain('compiler=aarch64-linux-gnu-gcc')
    expect(compile.args.at(-2)).toBe('arm64')
  })

  it('fails instead of falling back to the newer host compiler', () => {
    const { output, run } = builder('x64', '2.39')
    run.mockReturnValue({ code: 1, stdout: '', stderr: 'toolchain unavailable' })
    expect(() => buildJournalFileLock(output, 'x64', { run })).toThrow('toolchain unavailable')
  })
})
