import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function unitInputSourceDigest(sources) {
  return createHash('sha256')
    .update(JSON.stringify([...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest('hex')
}

function repositoryInput(path) {
  return (
    typeof path === 'string' &&
    /^(?:src|config|tests)\//.test(path) &&
    !/[\\*?[\]{}]/.test(path) &&
    path
      .split('/')
      .every((part, index, parts) =>
        part === '' ? index === parts.length - 1 : part !== '.' && part !== '..'
      )
  )
}

export function readUnitInputOwnership(root) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, 'config/scripts/ci-unit-input-ownership.json'), 'utf8')
    )
    return manifest?.version === 1 && Array.isArray(manifest.records) ? manifest.records : []
  } catch {
    return []
  }
}

export function checkUnitInputOwnership(
  records,
  sourceClosure,
  env = process.env,
  contextSha256 = unitInputSourceDigest(new Map())
) {
  const checked = new Map()
  if (!Array.isArray(records)) {
    return checked
  }
  const counts = new Map()
  for (const record of records) {
    if (typeof record?.file === 'string') {
      counts.set(record.file, (counts.get(record.file) ?? 0) + 1)
    }
  }
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      continue
    }
    const { file, inputs, emptyEnv, sourceClosureSha256, reason } = record
    if (
      counts.get(file) !== 1 ||
      !repositoryInput(file) ||
      file.endsWith('/') ||
      !Array.isArray(inputs) ||
      !inputs.every(repositoryInput) ||
      !Array.isArray(emptyEnv) ||
      !emptyEnv.every((name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name)) ||
      emptyEnv.some((name) => Boolean(env[name])) ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      typeof sourceClosureSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sourceClosureSha256) ||
      record.contextSha256 !== contextSha256
    ) {
      continue
    }
    const sources = sourceClosure(file)
    if (!sources || !sources.has(file) || unitInputSourceDigest(sources) !== sourceClosureSha256) {
      continue
    }
    checked.set(file, { inputs })
  }
  return checked
}
