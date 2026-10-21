import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyLinuxGlibcFloor } = require('./verify-linux-glibc-floor.cjs')
const roots = []
const STATIC_HEADERS = 'Program Header:\n    LOAD off 0x0000000000000000\n'
const MUSL_TARGET = 'orcad-template/targets/linux-arm64-musl/watcher.node'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writeObjdumpFixture(
  headers,
  { filename = 'browser', symbolTableError = false } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-glibc-payload-'))
  roots.push(root)
  const app = join(root, 'app')
  const binary = join(app, ...filename.split('/'))
  await mkdir(dirname(binary), { recursive: true })
  const elf = Buffer.alloc(64)
  elf.write('\x7fELF', 0, 'latin1')
  elf[4] = 2
  elf[5] = 1
  elf[6] = 1
  elf.writeUInt16LE(0xb7, 18)
  await writeFile(binary, elf)
  await writeFile(join(root, 'private-headers.txt'), headers)
  const objdumpPath = join(root, 'objdump-stub.sh')
  await writeFile(
    objdumpPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "GNU objdump (fixture)" ;;',
      '  -p) cat "$(dirname "$0")/private-headers.txt" ;;',
      symbolTableError
        ? '  -T) echo "not a dynamic object" >&2; exit 1 ;;'
        : '  -T) echo "0000 DF *UND* 0000 openpty" ;;',
      'esac'
    ].join('\n'),
    { mode: 0o755 }
  )
  return () => verifyLinuxGlibcFloor(app, { objdumpPath, targetArch: 'arm64' })
}

describe.skipIf(process.platform === 'win32')('static ELF and remote musl payloads', () => {
  it.each(['', '\nDynamic Section:\n'])(
    'accepts static LOAD segments with no dynamic imports (section suffix %j)',
    async (suffix) => {
      const verify = await writeObjdumpFixture(STATIC_HEADERS + suffix, { symbolTableError: true })
      expect(verify).not.toThrow()
    }
  )

  it.each([
    ['missing program headers', 'Dynamic Section:\n'],
    ['dynamic segment', `${STATIC_HEADERS} DYNAMIC off 0x0000000000001000\n`],
    ['interpreter segment', `${STATIC_HEADERS} INTERP off 0x0000000000001000\n`],
    ['dependency without a dynamic segment', `${STATIC_HEADERS}  NEEDED libc.so.6\n`]
  ])('preserves symbol-table failures for %s', async (_label, headers) => {
    const verify = await writeObjdumpFixture(headers, { symbolTableError: true })
    expect(verify).toThrow(/objdump -T failed/)
  })

  it.each(['libc.so', 'libc.musl-aarch64.so.1'])(
    'does not apply Ubuntu C++ or libutil requirements to a remote payload linked to %s',
    async (libc) => {
      const verify = await writeObjdumpFixture(
        `Dynamic Section:\n  NEEDED ${libc}\n  NEEDED libstdc++.so.6\n` +
          'Version References:\n  required from libstdc++.so.6:\n    0x0 0x00 02 GLIBCXX_3.4.29\n',
        { filename: MUSL_TARGET }
      )
      expect(verify).not.toThrow()
    }
  )

  it.each([
    ['desktop addon', 'watcher.node', 'libc.so'],
    ['glibc target', 'orcad-template/targets/linux-arm64-glibc/watcher.node', 'libc.so'],
    ['mislabeled glibc target', MUSL_TARGET, 'libc.so.6'],
    ['mixed libc dependencies', MUSL_TARGET, 'libc.so\n  NEEDED libc.so.6']
  ])('retains Ubuntu floor and provider checks for %s', async (_label, filename, libc) => {
    const verify = await writeObjdumpFixture(
      `Dynamic Section:\n  NEEDED ${libc}\n  NEEDED libstdc++.so.6\n` +
        'Version References:\n  required from libstdc++.so.6:\n    0x0 0x00 02 GLIBCXX_3.4.29\n',
      { filename }
    )
    expect(verify).toThrow(
      /needs GLIBCXX_3.4.29.*imports openpty but libutil.so.1 is not in DT_NEEDED/
    )
  })

  it('still rejects too-new glibc version needs in a musl payload', async () => {
    const verify = await writeObjdumpFixture(
      'Dynamic Section:\n  NEEDED libc.so\nVersion References:\n' +
        '  required from libc.so:\n    0x0 0x00 02 GLIBC_2.34\n',
      { filename: MUSL_TARGET }
    )
    expect(verify).toThrow(/needs GLIBC_2.34/)
  })

  it('retains the provider check when version references disclose a glibc dependency', async () => {
    const verify = await writeObjdumpFixture(
      'Dynamic Section:\n  NEEDED libc.so\nVersion References:\n' +
        '  required from libc.so.6:\n    0x0 0x00 02 GLIBC_2.17\n',
      { filename: MUSL_TARGET }
    )
    expect(verify).toThrow(/imports openpty but libutil.so.1 is not in DT_NEEDED/)
  })

  it('preserves objdump failures for a musl-labeled file without proven musl dependencies', async () => {
    const verify = await writeObjdumpFixture('Dynamic Section:\n', {
      filename: MUSL_TARGET,
      symbolTableError: true
    })
    expect(verify).toThrow(/objdump -T failed/)
  })
})
