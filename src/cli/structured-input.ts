import { resolve } from 'node:path'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../shared/node-bounded-file-reader'
import { RuntimeClientError } from './runtime-client'

export const CLI_STRUCTURED_INPUT_MAX_BYTES = 512 * 1024

type StructuredInputOptions = {
  flags: Map<string, string | boolean>
  cwd: string
  inlineFlag: string
  fileFlag: string
  label: string
}

function invalidInput(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function decodeUtf8(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw invalidInput(`${label} must be valid UTF-8.`)
  }
}

async function readStdinWithinLimit(maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let byteCount = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    byteCount += buffer.byteLength
    if (byteCount > maxBytes) {
      throw new NodeFileReadTooLargeError(byteCount, maxBytes)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, byteCount)
}

async function readSource(
  source: string,
  cwd: string,
  maxBytes: number,
  label: string
): Promise<string> {
  try {
    const buffer =
      source === '-'
        ? await readStdinWithinLimit(maxBytes)
        : (await readNodeFileWithinLimit(resolve(cwd, source), maxBytes)).buffer
    return decodeUtf8(buffer, label)
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    if (error instanceof NodeFileReadTooLargeError) {
      throw invalidInput(`${label} exceeds the ${maxBytes}-byte CLI input limit.`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw invalidInput(`Unable to read ${label}: ${message}`)
  }
}

export async function readStructuredInput({
  flags,
  cwd,
  inlineFlag,
  fileFlag,
  label
}: StructuredInputOptions): Promise<string> {
  const inline = flags.get(inlineFlag)
  const file = flags.get(fileFlag)
  const hasInline = flags.has(inlineFlag)
  const hasFile = flags.has(fileFlag)

  if (hasInline && hasFile) {
    throw invalidInput(`Choose either --${inlineFlag} or --${fileFlag}, not both.`)
  }
  if (!hasInline && !hasFile) {
    throw invalidInput(`Missing required --${inlineFlag} or --${fileFlag}.`)
  }
  if (hasInline && typeof inline !== 'string') {
    throw invalidInput(`Missing value for --${inlineFlag}.`)
  }
  if (hasFile && (typeof file !== 'string' || file.length === 0)) {
    throw invalidInput(`Missing value for --${fileFlag}.`)
  }

  let value: string
  if (typeof inline === 'string') {
    if (Buffer.byteLength(inline, 'utf8') > CLI_STRUCTURED_INPUT_MAX_BYTES) {
      throw invalidInput(
        `${label} exceeds the ${CLI_STRUCTURED_INPUT_MAX_BYTES}-byte CLI input limit.`
      )
    }
    value = inline
  } else if (typeof file === 'string') {
    value = await readSource(file, cwd, CLI_STRUCTURED_INPUT_MAX_BYTES, label)
  } else {
    throw invalidInput(`Missing required --${inlineFlag} or --${fileFlag}.`)
  }

  if (value.trim().length === 0) {
    throw invalidInput(`${label} cannot be empty.`)
  }
  return value
}

export async function readJsonObjectInput(
  options: StructuredInputOptions
): Promise<Record<string, unknown>> {
  const raw = await readStructuredInput(options)
  try {
    const value: unknown = JSON.parse(raw)
    if (!isJsonObject(value)) {
      throw new Error('not_an_object')
    }
    return value
  } catch {
    throw invalidInput(`${options.label} must be a JSON object.`)
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
