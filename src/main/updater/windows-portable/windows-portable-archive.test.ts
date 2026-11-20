import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { extractWindowsPortableArchive } from './windows-portable-archive'
import { parseSha256ChecksumFile } from './windows-portable-package'
import { ensureWindowsAppDataPath } from '../../startup/windows-startup/windows-app-data-path'

type RawZipSpec = {
  name: string
  data?: Buffer
  deflate?: boolean
  unixMode?: number
  corruptCrc?: boolean
}

function buildTestZipBuffer(specs: RawZipSpec[], eocdCountOverride?: number): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const spec of specs) {
    const nameBuf = Buffer.from(spec.name, 'utf8')
    const rawData = spec.data ?? Buffer.alloc(0)
    const isDir = spec.name.endsWith('/')
    const method = !isDir && spec.deflate ? 8 : 0
    const payload = method === 8 ? deflateRawSync(rawData) : rawData
    const baseCrc = isDir ? 0 : crc32(rawData) >>> 0
    const entryCrc = spec.corruptCrc ? (baseCrc ^ 0xffffffff) >>> 0 : baseCrc

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(entryCrc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(rawData.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(entryCrc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(rawData.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    const mode = spec.unixMode ?? (isDir ? 0o040755 : 0o100644)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)

    localParts.push(local, nameBuf, payload)
    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  const reportedCount = eocdCountOverride ?? specs.length
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(reportedCount, 8)
  eocd.writeUInt16LE(reportedCount, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...localParts, centralBuffer, eocd])
}

function validPortableSpecs(extra: RawZipSpec[] = []): RawZipSpec[] {
  return [
    { name: 'Orca-portable/' },
    { name: 'Orca-portable/Orca.exe', data: Buffer.from('MZ-orca-binary'), deflate: true },
    { name: 'Orca-portable/resources/' },
    { name: 'Orca-portable/resources/app.asar', data: Buffer.from('asar-payload'), deflate: true },
    { name: 'Orca-portable/resources/package-type', data: Buffer.from('portable\n') },
    { name: 'Orca-portable/data/.keep', data: Buffer.from('ignored-user-data') },
    ...extra
  ]
}

describe('windows-portable-archive', () => {
  const tempDirs: string[] = []

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'orca-portable-archive-test-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('extracts valid stored and deflated payload files while skipping data/', async () => {
    const root = await makeTempDir()
    const zipPath = join(root, 'portable.zip')
    const outDir = join(root, 'staged')
    await writeFile(zipPath, buildTestZipBuffer(validPortableSpecs()))

    await extractWindowsPortableArchive(zipPath, outDir)

    expect(await readFile(join(outDir, 'Orca.exe'), 'utf8')).toBe('MZ-orca-binary')
    expect(await readFile(join(outDir, 'resources', 'app.asar'), 'utf8')).toBe('asar-payload')
    expect((await readFile(join(outDir, 'resources', 'package-type'), 'utf8')).trim()).toBe(
      'portable'
    )
    await expect(stat(join(outDir, 'data'))).rejects.toThrow()
  })

  it('rejects path traversal, symlinks, duplicates, and corrupt central directory counts', async () => {
    const root = await makeTempDir()

    const traversalZip = join(root, 'traversal.zip')
    await writeFile(
      traversalZip,
      buildTestZipBuffer(validPortableSpecs([{ name: 'Orca-portable/../escape.exe' }]))
    )
    await expect(extractWindowsPortableArchive(traversalZip, join(root, 'out1'))).rejects.toThrow(
      /unsafe path/i
    )

    const symlinkZip = join(root, 'symlink.zip')
    await writeFile(
      symlinkZip,
      buildTestZipBuffer(
        validPortableSpecs([
          { name: 'Orca-portable/link.exe', data: Buffer.from('target'), unixMode: 0o120777 }
        ])
      )
    )
    await expect(extractWindowsPortableArchive(symlinkZip, join(root, 'out2'))).rejects.toThrow(
      /symbolic link/i
    )

    const duplicateZip = join(root, 'duplicate.zip')
    await writeFile(
      duplicateZip,
      buildTestZipBuffer(
        validPortableSpecs([{ name: 'Orca-portable/orca.exe', data: Buffer.from('dup') }])
      )
    )
    await expect(extractWindowsPortableArchive(duplicateZip, join(root, 'out3'))).rejects.toThrow(
      /duplicate entry/i
    )

    const countMismatchZip = join(root, 'count.zip')
    const specs = validPortableSpecs()
    await writeFile(countMismatchZip, buildTestZipBuffer(specs, specs.length - 1))
    await expect(
      extractWindowsPortableArchive(countMismatchZip, join(root, 'out4'))
    ).rejects.toThrow(/entry count mismatch/i)

    const badCrcZip = join(root, 'crc.zip')
    await writeFile(
      badCrcZip,
      buildTestZipBuffer(
        validPortableSpecs([{ name: 'Orca-portable/bad.dll', data: Buffer.from('x'), corruptCrc: true }])
      )
    )
    await expect(extractWindowsPortableArchive(badCrcZip, join(root, 'out5'))).rejects.toThrow(
      /CRC-32 mismatch/i
    )

    const trailingDotZip = join(root, 'trailing-dot.zip')
    await writeFile(
      trailingDotZip,
      buildTestZipBuffer(validPortableSpecs([{ name: 'Orca-portable/README.txt.', data: Buffer.from('x') }]))
    )
    await expect(extractWindowsPortableArchive(trailingDotZip, join(root, 'out6'))).rejects.toThrow(
      /unsafe path/i
    )

    const deviceNameZip = join(root, 'device.zip')
    await writeFile(
      deviceNameZip,
      buildTestZipBuffer(validPortableSpecs([{ name: 'Orca-portable/CON.txt', data: Buffer.from('x') }]))
    )
    await expect(extractWindowsPortableArchive(deviceNameZip, join(root, 'out7'))).rejects.toThrow(
      /unsafe path/i
    )
  })

  it('parses SHA-256 checksum files and routes Windows portable userData to <execDir>\\data', () => {
    const digest = 'a'.repeat(64)
    expect(
      parseSha256ChecksumFile(
        `${digest}  orca-windows-x64-portable.zip\n`,
        'orca-windows-x64-portable.zip'
      )
    ).toBe(digest)

    const setPaths = new Map<string, string>()
    ensureWindowsAppDataPath(
      {
        getPath: () => 'C:\\Users\\Alice\\AppData\\Roaming',
        setPath: (name, value) => setPaths.set(name, value),
        getName: () => 'Orca',
        commandLine: { hasSwitch: () => false }
      },
      {},
      'win32',
      { isPortable: true, execPath: 'D:\\Tools\\Orca-portable\\Orca.exe' }
    )
    expect(setPaths.get('userData')).toBe('D:\\Tools\\Orca-portable\\data')
  })
})
