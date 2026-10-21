const TRAILER = '\n//# vitestCache='
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (message) => {
  throw new Error(`Unit module cache: ${message}`)
}

export function checkModuleTrailer(buffer) {
  const text = buffer.toString('utf8')
  if (!Buffer.from(text).equals(buffer)) {
    fail('module is not valid UTF-8')
  }
  const marker = text.lastIndexOf(TRAILER)
  if (marker === -1) {
    fail('module trailer is missing')
  }
  const encoded = text.slice(marker + TRAILER.length)
  const decoded = Buffer.from(encoded, 'base64')
  if (!encoded || decoded.toString('base64') !== encoded) {
    fail('module trailer is not canonical base64')
  }
  const json = decoded.toString('utf8')
  if (!Buffer.from(json).equals(decoded)) {
    fail('module metadata is not valid UTF-8')
  }
  const table = JSON.parse(json)
  if (!Array.isArray(table) || !isRecord(table[0])) {
    fail('module metadata is not a flatted object table')
  }
  const resolve = (value) => {
    if (typeof value !== 'string') {
      return value
    }
    if (
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) >= table.length
    ) {
      fail('invalid flatted reference')
    }
    return table[Number(value)]
  }
  // Check table references directly; the cache only needs the documented metadata fields.
  for (const slot of table) {
    if (typeof slot === 'string') {
      continue
    }
    if (!slot || typeof slot !== 'object') {
      fail('invalid flatted table slot')
    }
    if (Object.hasOwn(slot, '__proto__')) {
      fail('unsafe flatted property')
    }
    for (const value of Object.values(slot)) {
      if (value !== null && typeof value === 'object') {
        fail('inline object in flatted table')
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        fail('invalid flatted number')
      }
      resolve(value)
    }
  }
  const fields = Object.fromEntries(
    Object.entries(table[0]).map(([name, value]) => [name, resolve(value)])
  )
  const strings = (value) =>
    Array.isArray(value) && value.every((item) => typeof resolve(item) === 'string')
  if (typeof fields.id !== 'string' || typeof fields.url !== 'string') {
    fail('invalid module id or url')
  }
  if (fields.file != null && typeof fields.file !== 'string') {
    fail('invalid module file')
  }
  if (typeof fields.mappings !== 'boolean') {
    fail('invalid module mappings')
  }
  if (
    fields.moduleType !== undefined &&
    fields.moduleType !== 'cjs' &&
    fields.moduleType !== 'esm'
  ) {
    fail('invalid module type')
  }
  if (!isRecord(fields.imports)) {
    fail('invalid module imports')
  }
  const urls = resolve(fields.imports.urls)
  const ids = resolve(fields.imports.ids)
  if (
    !strings(urls) ||
    !isRecord(ids) ||
    !Object.values(ids).every((id) => typeof resolve(id) === 'string')
  ) {
    fail('invalid module import references')
  }
  for (const name of ['deps', 'dynamicDeps']) {
    if (fields[name] !== undefined && !strings(fields[name])) {
      fail(`invalid module ${name}`)
    }
  }
  if (fields.staticMocks != null) {
    if (!Array.isArray(fields.staticMocks)) {
      fail('invalid module static mocks')
    }
    for (const reference of fields.staticMocks) {
      const mock = resolve(reference)
      if (
        !isRecord(mock) ||
        typeof resolve(mock.method) !== 'string' ||
        typeof resolve(mock.specifier) !== 'string' ||
        typeof mock.hasFactory !== 'boolean' ||
        typeof mock.factoryLoadsOriginal !== 'boolean'
      ) {
        fail('invalid module static mock')
      }
    }
  }
}
