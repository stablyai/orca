import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { lookup }: { lookup: (path: string) => string | false } = require('mime-types')

export type OpenCodeTextTaskInput = {
  directory: string
  prompt: string
  serverArgs: string[]
  agent?: string
  model?: string
  variant?: string
  title?: string
  command?: string
  v1Files?: { type: 'file'; mime: string; filename: string; url: string }[]
  v2Files?: { uri: string; name: string }[]
}

const aliases: Record<string, string> = {
  m: 'model',
  f: 'file',
  c: 'continue',
  s: 'session',
  p: 'password',
  u: 'username',
  i: 'interactive'
}
const commonStrings = ['model', 'agent', 'format', 'file', 'title', 'session']
const commonBooleans = [
  'continue',
  'fork',
  'thinking',
  'auto',
  'yolo',
  'dangerously-skip-permissions',
  'print-logs'
]
const v1Strings = [
  'command',
  'attach',
  'password',
  'username',
  'dir',
  'port',
  'variant',
  'replay-limit',
  'log-level'
]
const v1Booleans = ['share', 'mini', 'replay', 'interactive', 'demo', 'pure']

function parseRunArgs(args: readonly string[], v2: boolean, legacyVariantFlag: boolean) {
  const values = new Map<string, string>()
  const flags = new Map<string, boolean>()
  const files: string[] = []
  const message: string[] = []
  const strings = new Set([
    ...commonStrings,
    ...(v2 ? ['server', ...(legacyVariantFlag ? ['variant'] : [])] : v1Strings)
  ])
  const booleans = new Set([...commonBooleans, ...(v2 ? ['standalone'] : v1Booleans)])
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === '--') {
      message.push(...args.slice(index + 1))
      break
    }
    if (token === '-' || !token.startsWith('-')) {
      message.push(token)
      continue
    }
    const match = token.match(/^--([^=]+)(?:=(.*))?$/) ?? token.match(/^-([a-z])(.*)$/)
    if (!match) {
      throw new Error('OpenCode run option is invalid')
    }
    let name = aliases[match[1]] ?? match[1]
    let value: string | undefined = match[2]
    if (!token.startsWith('--') && !value) {
      value = undefined
    }
    const negated = name.startsWith('no-')
    if (negated) {
      name = name.slice(3)
    }
    if (booleans.has(name)) {
      if (value !== undefined && value !== 'true' && value !== 'false') {
        throw new Error('OpenCode boolean run option is invalid')
      }
      if (value === undefined && ['true', 'false'].includes(args[index + 1])) {
        value = args[++index]
      }
      flags.set(name, negated ? false : value !== 'false')
      continue
    }
    if (!strings.has(name) || negated) {
      throw new Error('OpenCode run option is unsupported')
    }
    if (value === undefined) {
      if (args[index + 1] !== undefined && !args[index + 1].startsWith('-')) {
        value = args[++index]
      } else if (name === 'title' && !v2) {
        value = ''
      } else {
        throw new Error('OpenCode run option requires a value')
      }
    }
    if (name === 'file') {
      files.push(value)
      // v1's yargs file option is an array; v2's repeated flag consumes one value.
      if (!v2 && !token.includes('=')) {
        while (args[index + 1] !== undefined && !args[index + 1].startsWith('-')) {
          files.push(args[++index])
        }
      }
    } else {
      if (values.has(name)) {
        throw new Error('OpenCode singleton run option is repeated')
      }
      values.set(name, value)
    }
  }
  return { values, flags, files, message }
}

async function prepareV2File(file: string, directory: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const filename = path.resolve(directory, file)
  const handle = await open(filename, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 10 * 1024 * 1024) {
      throw new Error('OpenCode attachment must be a regular file no larger than 10 MiB')
    }
    const content = Buffer.alloc(info.size)
    let offset = 0
    while (offset < content.length) {
      signal.throwIfAborted()
      const read = await handle.read(content, offset, content.length - offset, offset)
      if (read.bytesRead === 0) {
        break
      }
      offset += read.bytesRead
    }
    const bytes = content.subarray(0, offset)
    const detected = lookup(filename) || 'application/octet-stream'
    const text = bytes.toString('utf8')
    const binary =
      bytes.includes(0) ||
      (bytes.length > 0 &&
        bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0) /
          bytes.length >
          0.3)
    const mime =
      detected.startsWith('image/') || detected === 'application/pdf'
        ? detected
        : !binary && Buffer.from(text, 'utf8').equals(bytes)
          ? 'text/plain'
          : detected
    const name = path.basename(filename)
    return mime === 'text/plain'
      ? { text: `<file name="${name}">\n${text}\n</file>` }
      : { attachment: { name, uri: `data:${mime};base64,${bytes.toString('base64')}` } }
  } finally {
    await handle.close()
  }
}

/** Resolve the selected CLI's run contract on the host that owns its filesystem. */
export async function prepareOpenCodeTextTaskInput(input: {
  version: 'v1' | 'v2'
  cwd: string
  prompt: string
  runArgs: readonly string[]
  signal: AbortSignal
  agent?: string
  model?: string
  variant?: string
  legacyVariantFlag?: boolean
}): Promise<OpenCodeTextTaskInput> {
  input.signal.throwIfAborted()
  const v2 = input.version === 'v2'
  const { values, flags, files, message } = parseRunArgs(
    input.runArgs,
    v2,
    input.legacyVariantFlag === true
  )
  let model = values.get('model') ?? input.model
  if (v2 && values.has('variant')) {
    if (!model) {
      throw new Error('OpenCode variant compatibility requires a model')
    }
    // Preserve the existing pre-prompt CLI compatibility projection, including suffix precedence.
    model = `${model.split('#')[0]}#${values.get('variant')}`
  }
  if (values.has('format') && !['default', 'json'].includes(values.get('format')!)) {
    throw new Error('OpenCode output format is invalid')
  }
  if (flags.get('mini') || flags.get('demo') || values.has('replay-limit')) {
    throw new Error('OpenCode interactive invocation cannot run as a hidden text task')
  }
  if (flags.get('fork') && !flags.get('continue') && !values.has('session')) {
    throw new Error('OpenCode fork requires a session')
  }
  // These modes have user-owned history/account/retention semantics; never silently discard them.
  if (
    flags.get('continue') ||
    flags.get('fork') ||
    flags.get('share') ||
    ['session', 'attach', 'server', 'password', 'username'].some((name) => values.has(name))
  ) {
    throw new Error('OpenCode text task requires a fresh private session')
  }
  const directory = path.resolve(input.cwd, values.get('dir') || '.')
  const positional = message
    .map((part) => (part.includes(' ') ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ')
  let prompt =
    positional && input.prompt ? `${positional}\n${input.prompt}` : positional || input.prompt
  if (!prompt.trim() && !values.has('command')) {
    throw new Error('OpenCode text task has no input')
  }
  const serverArgs: string[] = []
  if (flags.get('print-logs')) {
    serverArgs.push('--print-logs')
  }
  if (!v2 && flags.get('pure')) {
    serverArgs.push('--pure')
  }
  if (values.has('log-level')) {
    const level = values.get('log-level')!
    if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level)) {
      throw new Error('OpenCode log level is invalid')
    }
    serverArgs.push('--log-level', level)
  }
  const result: OpenCodeTextTaskInput = {
    directory,
    prompt,
    serverArgs,
    agent: values.get('agent') ?? input.agent,
    model,
    variant: v2 ? input.variant : (values.get('variant') ?? input.variant),
    command: values.get('command'),
    title: values.has('title')
      ? values.get('title') || prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '')
      : undefined
  }
  if (v2) {
    if (files.length > 100) {
      throw new Error('OpenCode accepts at most 100 attachments')
    }
    const text: string[] = []
    result.v2Files = []
    for (const file of files) {
      const prepared = await prepareV2File(file, directory, input.signal)
      if (prepared.text) {
        text.push(prepared.text)
      }
      if (prepared.attachment) {
        result.v2Files.push(prepared.attachment)
      }
    }
    prompt = [prompt, ...text].join('\n\n')
    result.prompt = prompt
  } else {
    result.v1Files = []
    for (const file of files) {
      input.signal.throwIfAborted()
      const filename = path.resolve(directory, file)
      const info = await stat(filename)
      result.v1Files.push({
        type: 'file',
        mime: info.isDirectory() ? 'application/x-directory' : 'text/plain',
        filename: path.basename(filename),
        url: pathToFileURL(filename).href
      })
    }
  }
  input.signal.throwIfAborted()
  return result
}
