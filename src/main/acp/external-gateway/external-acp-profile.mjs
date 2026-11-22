import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,254}$/
const ALLOWED_FIELDS = new Set([
  'nativeCommand',
  'nativeHome',
  'nativeArgs',
  'gatewayBaseUrl',
  'modelIds',
  'defaultModel',
  'credentialCommand',
  'timeoutMs'
])

function invalidProfile() {
  return new Error('The external ACP profile is invalid. Check its command, home, URL, and models.')
}

function validModelList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((model) => typeof model === 'string' && MODEL_ID.test(model))
  )
}

export function parseExternalAcpProfileArgs(args) {
  if (
    ![2, 3].includes(args.length) ||
    args[0] !== '--profile' ||
    !isAbsolute(args[1]) ||
    (args.length === 3 && args[2] !== '--uid=')
  ) {
    throw new Error('Usage: external-acp-launcher --profile <absolute-profile-json-path>')
  }
  return args[1]
}

export function validateExternalAcpProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProfile()
  }
  if (Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw invalidProfile()
  }
  if (typeof value.nativeCommand !== 'string' || !isAbsolute(value.nativeCommand)) {
    throw invalidProfile()
  }
  if (typeof value.nativeHome !== 'string' || !isAbsolute(value.nativeHome)) {
    throw invalidProfile()
  }
  if (value.nativeArgs !== undefined && !Array.isArray(value.nativeArgs)) {
    throw invalidProfile()
  }
  if (value.nativeArgs?.some((arg) => !['--debug', '--uid='].includes(arg))) {
    throw invalidProfile()
  }
  let gateway
  try {
    gateway = new URL(value.gatewayBaseUrl)
  } catch {
    throw invalidProfile()
  }
  if (
    !(
      gateway.protocol === 'https:' ||
      (gateway.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname))
    ) ||
    !gateway.host ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    gateway.pathname.endsWith('/chat/completions')
  ) {
    throw invalidProfile()
  }
  const modelIds = value.modelIds
  if (!validModelList(modelIds)) {
    throw invalidProfile()
  }
  if (
    value.defaultModel !== undefined &&
    (typeof value.defaultModel !== 'string' || !MODEL_ID.test(value.defaultModel))
  ) {
    throw invalidProfile()
  }
  if (value.credentialCommand !== undefined) {
    if (typeof value.credentialCommand !== 'string' || !isAbsolute(value.credentialCommand)) {
      throw invalidProfile()
    }
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 20 || value.timeoutMs > 60_000)
  ) {
    throw invalidProfile()
  }
  const nativeBaseUrl = new URL(gateway)
  nativeBaseUrl.pathname = nativeBaseUrl.pathname
    .replace(/\/(?:v1|v1beta)\/?$/, '')
    .replace(/\/$/, '')
  const openAiChatUrl = new URL(gateway)
  openAiChatUrl.pathname = `${gateway.pathname.replace(/\/$/, '')}/chat/completions`
  return {
    nativeCommand: value.nativeCommand,
    nativeHome: value.nativeHome,
    nativeArgs: value.nativeArgs ?? [],
    gatewayBaseUrl: nativeBaseUrl.pathname.replace(/\/$/, ''),
    openAiChatUrl: openAiChatUrl.toString(),
    modelIds,
    defaultModel: value.defaultModel ?? modelIds[0],
    credentialCommand: value.credentialCommand,
    timeoutMs: value.timeoutMs ?? 30_000
  }
}

export async function readExternalAcpProfile(path) {
  let value
  try {
    value = JSON.parse(await readFile(path, { encoding: 'utf8', flag: 'r' }))
  } catch {
    throw invalidProfile()
  }
  const profile = validateExternalAcpProfile(value)
  const native = await stat(profile.nativeCommand).catch(() => null)
  if (!native?.isFile()) {
    throw invalidProfile()
  }
  return profile
}
