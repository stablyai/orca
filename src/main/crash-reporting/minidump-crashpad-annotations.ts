// Reads Chromium's crash keys out of a Crashpad minidump's annotation streams.
//
// Some Chromium builds expose the fatal log line as `LOG_FATAL`; the signature
// parser also handles builds that carry it only in captured process memory.
// Layouts are from Crashpad's minidump_extensions.h.

import {
  findStream,
  MAX_MODULES,
  type LocationDescriptor,
  type MinidumpView
} from './minidump-stream-reader'

// Why: a dump claiming an absurd annotation count is corrupt; cap before iterating.
const MAX_ANNOTATIONS = 512

const STREAM_TYPE_CRASHPAD_INFO = 0x43500001

const CRASHPAD_INFO_MIN_SIZE = 52
const CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET = 36
const CRASHPAD_INFO_MODULE_LIST_OFFSET = 44

const MODULE_CRASHPAD_INFO_LINK_SIZE = 12
const MODULE_CRASHPAD_INFO_MIN_SIZE = 28
// list_annotations at +4 is a keyless legacy RVA list; nothing we can attribute.
const MODULE_CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET = 12
const MODULE_CRASHPAD_INFO_ANNOTATION_OBJECTS_OFFSET = 20

const ANNOTATION_RECORD_SIZE = 12
const ANNOTATION_TYPE_STRING = 1

/**
 * Crashpad annotations we copy into a crash report.
 *
 * Why an allowlist: annotations are an open key space and some Chromium keys
 * (`switch-N`, extension ids) carry command lines and user data. Diagnostic
 * value here is concentrated in a handful of keys, so default-deny.
 */
const ANNOTATION_ALLOWLIST = new Set([
  // The whole point of this module — Chromium's fatal log line.
  'LOG_FATAL',
  'abort-message',
  // Which process died, independent of what Electron told us.
  'ptype',
  'ver',
  'prod',
  'plat',
  'osarch',
  'channel',
  // Distinguishes a one-off from a crash loop.
  'crash-loop-before',
  'first-crash-time',
  // The Linux SIGBUS/SIGSEGV reports are GPU-adjacent; driver identity matters.
  'gpu-gl-vendor',
  'gpu-gl-renderer',
  'gpu-driver-version',
  'gpu-vendor-id',
  'gpu-device-id',
  'gpu-generation-intel'
])

/** MinidumpSimpleStringDictionary: u32 count, then {key rva, value rva} pairs. */
async function readSimpleAnnotations(
  view: MinidumpView,
  location: LocationDescriptor | null,
  into: Record<string, string>
): Promise<void> {
  if (!location) {
    return
  }
  const count = await view.u32(location.rva)
  if (count === null || count > MAX_ANNOTATIONS || 4 + count * 8 > location.size) {
    return
  }
  for (let index = 0; index < count; index += 1) {
    const entry = location.rva + 4 + index * 8
    const keyRva = await view.u32(entry)
    const valueRva = await view.u32(entry + 4)
    if (keyRva === null || valueRva === null) {
      return
    }
    const key = await view.utf8String(keyRva, 256)
    if (key === null || !ANNOTATION_ALLOWLIST.has(key)) {
      continue
    }
    const value = await view.utf8String(valueRva)
    if (value !== null) {
      into[key] = value
    }
  }
}

/** MinidumpAnnotationList: u32 count, then MinidumpAnnotation records. */
async function readAnnotationObjects(
  view: MinidumpView,
  location: LocationDescriptor | null,
  into: Record<string, string>
): Promise<void> {
  if (!location) {
    return
  }
  const count = await view.u32(location.rva)
  if (
    count === null ||
    count > MAX_ANNOTATIONS ||
    4 + count * ANNOTATION_RECORD_SIZE > location.size
  ) {
    return
  }
  for (let index = 0; index < count; index += 1) {
    const entry = location.rva + 4 + index * ANNOTATION_RECORD_SIZE
    const nameRva = await view.u32(entry)
    const type = await view.u16(entry + 4)
    const valueRva = await view.u32(entry + 8)
    if (nameRva === null || type === null || valueRva === null) {
      return
    }
    if (type !== ANNOTATION_TYPE_STRING || valueRva === 0) {
      continue
    }
    const name = await view.utf8String(nameRva, 256)
    if (name === null || !ANNOTATION_ALLOWLIST.has(name)) {
      continue
    }
    const raw = await view.byteArray(valueRva)
    if (raw) {
      // Annotation strings are not NUL-terminated; trim a trailing one anyway.
      let value = raw.toString('utf8')
      while (value.endsWith('\0')) {
        value = value.slice(0, -1)
      }
      into[name] = value
    }
  }
}

export async function readCrashpadAnnotations(view: MinidumpView): Promise<Record<string, string>> {
  const annotations: Record<string, string> = {}
  const info = await findStream(view, STREAM_TYPE_CRASHPAD_INFO)
  if (!info || info.size < CRASHPAD_INFO_MIN_SIZE) {
    return annotations
  }

  await readSimpleAnnotations(
    view,
    await view.location(info.rva + CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET),
    annotations
  )

  const moduleList = await view.location(info.rva + CRASHPAD_INFO_MODULE_LIST_OFFSET)
  if (!moduleList) {
    return annotations
  }
  const moduleCount = await view.u32(moduleList.rva)
  if (moduleCount === null || moduleCount > MAX_MODULES) {
    return annotations
  }
  for (let index = 0; index < moduleCount; index += 1) {
    const link = moduleList.rva + 4 + index * MODULE_CRASHPAD_INFO_LINK_SIZE
    const moduleInfo = await view.location(link + 4)
    if (!moduleInfo || moduleInfo.size < MODULE_CRASHPAD_INFO_MIN_SIZE) {
      continue
    }
    // Why: Chromium's crash keys land in annotation_objects on current
    // Crashpad, but older modules still populate the two legacy shapes.
    await readSimpleAnnotations(
      view,
      await view.location(moduleInfo.rva + MODULE_CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET),
      annotations
    )
    await readAnnotationObjects(
      view,
      await view.location(moduleInfo.rva + MODULE_CRASHPAD_INFO_ANNOTATION_OBJECTS_OFFSET),
      annotations
    )
  }
  return annotations
}
