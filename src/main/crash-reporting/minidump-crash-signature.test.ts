import { describe, expect, it } from 'vitest'
import { minidumpSignatureDetails, parseMinidumpCrashSignature } from './minidump-crash-signature'

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_EXCEPTION = 6
const STREAM_TYPE_CRASHPAD_INFO = 0x43500001

/**
 * Builds real Crashpad-layout minidumps so the parser is tested against the
 * byte format rather than a mock. Regions are appended and referenced by RVA,
 * matching how Crashpad emits them.
 */
class MinidumpBuilder {
  private regions: Buffer[] = []
  private cursor = 0

  constructor(private readonly headerAndDirectoryBytes: number) {
    this.cursor = headerAndDirectoryBytes
  }

  append(buf: Buffer): number {
    const rva = this.cursor
    this.regions.push(buf)
    this.cursor += buf.length
    return rva
  }

  utf8String(value: string): number {
    const data = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(4 + data.length + 1)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  utf16String(value: string): number {
    const data = Buffer.from(value, 'utf16le')
    const buf = Buffer.alloc(4 + data.length + 2)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  byteArray(value: string): number {
    const data = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(4 + data.length)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  build(streams: { type: number; size: number; rva: number }[]): Buffer {
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0x504d444d, 0)
    header.writeUInt32LE(0xa793, 4)
    header.writeUInt32LE(streams.length, 8)
    header.writeUInt32LE(32, 12)
    const directory = Buffer.alloc(streams.length * 12)
    streams.forEach((stream, index) => {
      directory.writeUInt32LE(stream.type, index * 12)
      directory.writeUInt32LE(stream.size, index * 12 + 4)
      directory.writeUInt32LE(stream.rva, index * 12 + 8)
    })
    const body = Buffer.concat(this.regions)
    const prefix = Buffer.concat([header, directory])
    expect(prefix.length).toBe(this.headerAndDirectoryBytes)
    return Buffer.concat([prefix, body])
  }
}

function location(size: number, rva: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt32LE(size, 0)
  buf.writeUInt32LE(rva, 4)
  return buf
}

const EMPTY_LOCATION = location(0, 0)

type BuiltDump = { dump: Buffer }

/**
 * @param annotations key/value pairs written as MinidumpAnnotation objects
 *   hanging off a module's crashpad info, which is where Chromium crash keys
 *   (including LOG_FATAL) actually live.
 */
function buildDump(options: {
  annotations?: Record<string, string>
  simpleAnnotations?: Record<string, string>
  exception?: { code: number; address: bigint }
  modules?: { base: bigint; size: number; name: string }[]
}): BuiltDump {
  const streamCount =
    1 + (options.exception ? 1 : 0) + (options.modules && options.modules.length > 0 ? 1 : 0)
  const builder = new MinidumpBuilder(32 + streamCount * 12)
  const streams: { type: number; size: number; rva: number }[] = []

  // Module-level annotation objects.
  const annotationEntries = Object.entries(options.annotations ?? {})
  const annotationRecords = annotationEntries.map(([name, value]) => ({
    nameRva: builder.utf8String(name),
    valueRva: builder.byteArray(value)
  }))
  const annotationListBuf = Buffer.alloc(4 + annotationRecords.length * 12)
  annotationListBuf.writeUInt32LE(annotationRecords.length, 0)
  annotationRecords.forEach((record, index) => {
    const at = 4 + index * 12
    annotationListBuf.writeUInt32LE(record.nameRva, at)
    annotationListBuf.writeUInt16LE(1, at + 4) // kString
    annotationListBuf.writeUInt16LE(0, at + 6)
    annotationListBuf.writeUInt32LE(record.valueRva, at + 8)
  })
  const annotationListRva = builder.append(annotationListBuf)

  // Process-level simple string dictionary.
  const simpleEntries = Object.entries(options.simpleAnnotations ?? {})
  const simplePairs = simpleEntries.map(([key, value]) => ({
    keyRva: builder.utf8String(key),
    valueRva: builder.utf8String(value)
  }))
  const simpleBuf = Buffer.alloc(4 + simplePairs.length * 8)
  simpleBuf.writeUInt32LE(simplePairs.length, 0)
  simplePairs.forEach((pair, index) => {
    simpleBuf.writeUInt32LE(pair.keyRva, 4 + index * 8)
    simpleBuf.writeUInt32LE(pair.valueRva, 4 + index * 8 + 4)
  })
  const simpleRva = builder.append(simpleBuf)

  // MinidumpModuleCrashpadInfo (version, list_annotations, simple, objects).
  const moduleInfoBuf = Buffer.concat([
    (() => {
      const v = Buffer.alloc(4)
      v.writeUInt32LE(1, 0)
      return v
    })(),
    EMPTY_LOCATION,
    EMPTY_LOCATION,
    location(annotationListBuf.length, annotationListRva)
  ])
  const moduleInfoRva = builder.append(moduleInfoBuf)

  const moduleLinkBuf = Buffer.alloc(4 + 12)
  moduleLinkBuf.writeUInt32LE(1, 0)
  moduleLinkBuf.writeUInt32LE(0, 4) // minidump module index
  moduleLinkBuf.writeUInt32LE(moduleInfoBuf.length, 8)
  moduleLinkBuf.writeUInt32LE(moduleInfoRva, 12)
  const moduleLinkRva = builder.append(moduleLinkBuf)

  const crashpadInfoBuf = Buffer.concat([
    (() => {
      const v = Buffer.alloc(4 + 16 + 16)
      v.writeUInt32LE(1, 0)
      return v
    })(),
    location(simpleBuf.length, simpleRva),
    location(moduleLinkBuf.length, moduleLinkRva)
  ])
  const crashpadInfoRva = builder.append(crashpadInfoBuf)
  streams.push({
    type: STREAM_TYPE_CRASHPAD_INFO,
    size: crashpadInfoBuf.length,
    rva: crashpadInfoRva
  })

  if (options.modules && options.modules.length > 0) {
    const nameRvas = options.modules.map((module) => builder.utf16String(module.name))
    const listBuf = Buffer.alloc(4 + options.modules.length * 108)
    listBuf.writeUInt32LE(options.modules.length, 0)
    options.modules.forEach((module, index) => {
      const at = 4 + index * 108
      listBuf.writeBigUInt64LE(module.base, at)
      listBuf.writeUInt32LE(module.size, at + 8)
      listBuf.writeUInt32LE(nameRvas[index], at + 20)
    })
    streams.push({
      type: STREAM_TYPE_MODULE_LIST,
      size: listBuf.length,
      rva: builder.append(listBuf)
    })
  }

  if (options.exception) {
    const exceptionBuf = Buffer.alloc(168)
    exceptionBuf.writeUInt32LE(1234, 0) // ThreadId
    exceptionBuf.writeUInt32LE(options.exception.code, 8)
    exceptionBuf.writeBigUInt64LE(options.exception.address, 24)
    streams.push({
      type: STREAM_TYPE_EXCEPTION,
      size: exceptionBuf.length,
      rva: builder.append(exceptionBuf)
    })
  }

  return { dump: builder.build(streams) }
}

const FATAL_LINE =
  '[8104:1234:0815/143022.123456:FATAL:render_frame_impl.cc(4821)] Check failed: !is_detached_.'

const ELECTRON_43_CHECK_LINE =
  '[29136:0815/232206.330:ERROR:third_party\\blink\\common\\chrome_debug_urls.cc:180] Intentionally causing CHECK because user navigated to chrome://checkcrash/'

describe('parseMinidumpCrashSignature', () => {
  it('names the failing CHECK from the LOG_FATAL annotation', () => {
    const { dump } = buildDump({
      annotations: { LOG_FATAL: FATAL_LINE, ptype: 'renderer' }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.checkMessage).toBe(FATAL_LINE)
    expect(signature?.checkFile).toBe('render_frame_impl.cc')
    expect(signature?.checkLine).toBe(4821)
    expect(signature?.processType).toBe('renderer')
  })

  it('recovers a CHECK line from Electron 43 dump memory without LOG_FATAL', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory)

    expect(signature?.checkMessage).toBe(ELECTRON_43_CHECK_LINE)
    expect(signature?.checkFile).toBe('chrome_debug_urls.cc')
    expect(signature?.checkLine).toBe(180)
    expect(signature?.processType).toBe('renderer')
  })

  it('stops at the process type when the dump belongs to another process', () => {
    const { dump } = buildDump({ annotations: { ptype: 'gpu-process' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory, {
      expectedProcessType: 'renderer'
    })

    expect(signature?.processType).toBe('gpu-process')
    // The whole-buffer scan is skipped; the caller discards this dump anyway.
    expect(signature?.checkMessage).toBeUndefined()
  })

  it('still parses fully when the process type matches', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory, {
      expectedProcessType: 'renderer'
    })

    expect(signature?.checkMessage).toBe(ELECTRON_43_CHECK_LINE)
  })

  it('ignores a log prefix further back than the prefix limit', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    // `[` separated from the marker by more than MAX_LOG_PREFIX_BYTES (96).
    const farPrefix = `[${'x'.repeat(200)}:FATAL:render_frame_impl.cc(4821)] Check failed: far.`
    const dumpWithMemory = Buffer.concat([dump, Buffer.from(`\0${farPrefix}\0`, 'utf8')])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBeUndefined()
  })

  it('does not promote an unrelated Chromium ERROR line containing CHECK', () => {
    const { dump } = buildDump({})
    const unrelated =
      '[29136:0815/232206.330:ERROR:settings.cc:44] Opened the CHECK settings panel.'
    const dumpWithMemory = Buffer.concat([dump, Buffer.from(`\0${unrelated}\0`, 'utf8')])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBeUndefined()
  })

  it('prefers the structured annotation over a dump-memory candidate', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBe(FATAL_LINE)
  })

  it('reads annotations from the process-level simple string dictionary', () => {
    const { dump } = buildDump({
      simpleAnnotations: {
        ptype: 'gpu-process',
        'gpu-gl-vendor': 'Intel Inc.'
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.processType).toBe('gpu-process')
    expect(signature?.annotations['gpu-gl-vendor']).toBe('Intel Inc.')
  })

  it('drops annotations outside the allowlist', () => {
    const { dump } = buildDump({
      annotations: {
        LOG_FATAL: FATAL_LINE,
        'switch-3': '--user-data-dir=/Users/someone/secret'
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.annotations['switch-3']).toBeUndefined()
    expect(Object.keys(signature?.annotations ?? {})).toEqual(['LOG_FATAL'])
  })

  it('resolves the faulting module from the exception address', () => {
    const { dump } = buildDump({
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [
        {
          base: 0x7ff7_0000_0000n,
          size: 0x1000,
          name: 'C:\\Program Files\\Orca\\Orca.exe'
        },
        {
          base: 0x7ff8_0000_0000n,
          size: 0x10_0000,
          name: 'C:\\Program Files\\Orca\\chrome_elf.dll'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionCode).toBe(0x80000003)
    expect(signature?.exceptionAddress).toBe('0x7ff800001234')
    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleOffset).toBe('0x1234')
  })

  it('omits the faulting module when no image range covers the address', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x10n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: '/opt/orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionAddress).toBe('0x10')
    expect(signature?.faultingModule).toBeUndefined()
  })

  it('returns null for a buffer that is not a minidump', () => {
    expect(parseMinidumpCrashSignature(Buffer.from('not a dump at all', 'utf8'))).toBeNull()
    expect(parseMinidumpCrashSignature(Buffer.alloc(0))).toBeNull()
  })

  it('degrades instead of throwing on a truncated dump', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })

    const truncated = dump.subarray(0, 48)

    expect(() => parseMinidumpCrashSignature(truncated)).not.toThrow()
    expect(parseMinidumpCrashSignature(truncated)?.checkMessage).toBeUndefined()
  })

  it('degrades instead of throwing when stream counts are corrupt', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })
    const corrupt = Buffer.from(dump)
    corrupt.writeUInt32LE(0xffff_ffff, 8)

    expect(() => parseMinidumpCrashSignature(corrupt)).not.toThrow()
    expect(parseMinidumpCrashSignature(corrupt)?.annotations).toEqual({})
  })
})

describe('minidumpSignatureDetails', () => {
  it('flattens the check location and faulting module into detail keys', () => {
    const { dump } = buildDump({
      annotations: {
        LOG_FATAL: FATAL_LINE,
        ptype: 'renderer',
        channel: 'stable'
      },
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details).toMatchObject({
      minidumpCheckMessage: FATAL_LINE,
      minidumpCheckFile: 'render_frame_impl.cc',
      minidumpCheckLine: 4821,
      minidumpProcessType: 'renderer',
      minidumpExceptionCode: '0x80000003',
      minidumpFaultingModule: 'chrome_elf.dll',
      minidumpAnnotation_channel: 'stable'
    })
  })

  it('does not duplicate the fatal line into an annotation key', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details.minidumpAnnotation_LOG_FATAL).toBeUndefined()
  })
})
