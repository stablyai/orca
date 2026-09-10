import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { emit, git, root } from './rpc-artifact-io.mts'

const desktopPath = 'src/shared/protocol-version.ts'
const mobilePath = 'mobile/src/transport/protocol-version.ts'
function constants(source: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const match of source.matchAll(
    /export const ((?:RUNTIME|DESKTOP|MOBILE)_PROTOCOL_VERSION|MIN_COMPATIBLE_(?:RUNTIME_CLIENT|RUNTIME_SERVER|MOBILE|DESKTOP)_VERSION)\s*=\s*(\w+)/g
  )) {
    const value = /^\d+$/.test(match[2]) ? Number(match[2]) : result[match[2]]
    if (value !== undefined) {
      result[match[1]] = value
    }
  }
  return result
}
const current = []
for (const file of [desktopPath, mobilePath]) {
  const source = readFileSync(join(root, file), 'utf8')
  current.push({
    file,
    sourceSha: await git('log', '-1', '--format=%H', '--', file),
    sha256: createHash('sha256').update(source).digest('hex'),
    constants: constants(source)
  })
}
const desktop = current[0].constants,
  mobile = current[1].constants
for (const value of [
  desktop.RUNTIME_PROTOCOL_VERSION,
  desktop.MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  desktop.MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  mobile.MOBILE_PROTOCOL_VERSION,
  mobile.MIN_COMPATIBLE_DESKTOP_VERSION
]) {
  if (!Number.isInteger(value)) {
    throw new Error('Missing protocol gate constant')
  }
}
const tags = (
  await git(
    'tag',
    '--list',
    'v*',
    'mobile-v*',
    'mobile-ios-v*',
    'mobile-android-v*',
    '--sort=version:refname'
  )
).split('\n')
const namespaces = [
  {
    name: 'desktop-stable',
    pattern: /^v\d+\.\d+\.\d+$/,
    file: desktopPath,
    protocol: 'RUNTIME_PROTOCOL_VERSION',
    minimum: mobile.MIN_COMPATIBLE_DESKTOP_VERSION
  },
  {
    name: 'desktop-rc',
    pattern: /^v\d+\.\d+\.\d+-rc(?:[.-]?\d+)?$/,
    file: desktopPath,
    protocol: 'RUNTIME_PROTOCOL_VERSION',
    minimum: mobile.MIN_COMPATIBLE_DESKTOP_VERSION
  },
  ...['mobile-v', 'mobile-ios-v', 'mobile-android-v'].map((prefix) => ({
    name: `${prefix}*`,
    pattern: new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+(?:-rc[.-]?\\d+)?$`),
    file: mobilePath,
    protocol: 'MOBILE_PROTOCOL_VERSION',
    minimum: desktop.MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
  }))
]
const floors = []
for (const namespace of namespaces) {
  const candidates = tags.filter((tag) => namespace.pattern.test(tag))
  if (!candidates.length) {
    throw new Error(`No tags for ${namespace.name}`)
  }
  const inspected = []
  let floor: unknown, atMinimum3: unknown
  for (const tag of candidates) {
    const sha = await git('rev-parse', `${tag}^{commit}`)
    let source: string
    try {
      source = await git('show', `${sha}:${namespace.file}`)
    } catch {
      inspected.push({ tag, sha, excluded: 'protocol constant file absent' })
      continue
    }
    const values = constants(source)
    const version = values[namespace.protocol] ?? values.DESKTOP_PROTOCOL_VERSION
    if (!Number.isInteger(version)) {
      throw new Error(`Missing protocol at ${tag}:${namespace.file}`)
    }
    const peerMinimum =
      namespace.file === desktopPath
        ? (values.MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION ?? values.MIN_COMPATIBLE_MOBILE_VERSION)
        : values.MIN_COMPATIBLE_DESKTOP_VERSION
    if (!Number.isInteger(peerMinimum)) {
      throw new Error(`Missing peer minimum at ${tag}`)
    }
    const clientProtocol =
      namespace.file === desktopPath
        ? mobile.MOBILE_PROTOCOL_VERSION
        : desktop.RUNTIME_PROTOCOL_VERSION
    const evidence = {
      tag,
      sha,
      protocol: version,
      peerMinimum,
      protocolConstant:
        values[namespace.protocol] === undefined ? 'DESKTOP_PROTOCOL_VERSION' : namespace.protocol
    }
    inspected.push(evidence)
    if (!floor && version >= namespace.minimum && clientProtocol >= peerMinimum) {
      floor = evidence
    }
    if (!atMinimum3 && version >= 3 && clientProtocol >= peerMinimum) {
      atMinimum3 = evidence
    }
    if (floor && atMinimum3) {
      break
    }
  }
  if (!floor || !atMinimum3) {
    throw new Error(`No compatible floor in ${namespace.name}`)
  }
  floors.push({
    namespace: namespace.name,
    consideredTags: candidates,
    minimum: namespace.minimum,
    floor,
    atMinimum3,
    inspected
  })
}
emit('support-floor', {
  schemaVersion: 1,
  constants: current,
  retirementDecision: {
    text: '2026-09-09: desktop ≤ v1.4.4 and mobile ≤ v0.0.7 (protocol 2) retired; all three minimums → 3',
    decidedBy: 'Jinwoo'
  },
  directions: {
    mobileToHost:
      'host protocol >= mobile MIN_COMPATIBLE_DESKTOP_VERSION AND mobile protocol >= host minimum accepted client',
    hostToMobile:
      'mobile protocol >= host MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION AND host protocol >= mobile minimum accepted desktop',
    runtimeClientToServer:
      'server protocol >= MIN_COMPATIBLE_RUNTIME_SERVER_VERSION AND client protocol >= server minimum accepted client'
  },
  selection: 'version-sorted tags within each namespace; both compatibility directions must hold',
  floors
})
